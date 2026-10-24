# ==============================================================================
# Identificación con el usuario y la contraseña del sistema (zerochat/login)
# ==============================================================================

# Tras LOGIN_MAX_FAILURES fallos seguidos, los intentos se rechazan sin comprobarlos durante el bloqueo.
LOGIN_MAX_FAILURES = 5
LOGIN_LOCKOUT_SECONDS = 900.0
LOGIN_MAX_FIELD_LENGTH = 512
# Sin token solo se lee un cuerpo de este tamaño, el justo para zerochat/login.
LOGIN_MAX_BODY_BYTES = 4096
LOGIN_FAILED_CODE = -32001
LOGIN_LOCKED_CODE = -32002
LOGIN_PAM_SERVICE = "login"
LOGIN_LOCK = threading.Lock()
LOGIN_FAILURES = 0
LOGIN_LOCKED_UNTIL = 0.0


class LoginError(Exception):
    """Identificación rechazada: `code` es el error JSON-RPC y `data`, lo que necesita la interfaz."""
    def __init__(self, code: int, message: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data


def system_account() -> str:
    """Cuenta que ejecuta zerochat.py, la única que puede identificarse."""
    if os.name == "nt":
        return getpass.getuser()
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


def _pam_authenticate(user: str, password: str) -> bool:
    """PAM en Linux y macOS: un proceso sin privilegios comprueba su propia cuenta (unix_chkpwd en Linux)."""
    libpam_path = ctypes.util.find_library("pam")
    if not libpam_path:
        raise RuntimeError("PAM no está disponible en este sistema.")
    libpam = ctypes.CDLL(libpam_path)
    libc = ctypes.CDLL(ctypes.util.find_library("c"))
    libc.calloc.restype = ctypes.c_void_p
    libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    libc.strdup.restype = ctypes.c_void_p
    libc.strdup.argtypes = [ctypes.c_char_p]

    class PamMessage(ctypes.Structure):
        _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]

    class PamResponse(ctypes.Structure):
        _fields_ = [("resp", ctypes.c_void_p), ("resp_retcode", ctypes.c_int)]

    conv_func = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.POINTER(PamMessage)),
                                 ctypes.POINTER(ctypes.POINTER(PamResponse)), ctypes.c_void_p)

    class PamConv(ctypes.Structure):
        _fields_ = [("conv", conv_func), ("appdata_ptr", ctypes.c_void_p)]

    login_name = user.encode("utf-8")
    secret = password.encode("utf-8")

    def conversation(count, messages, response, _appdata):
        # PAM libera las respuestas: se reservan con la libc, no con Python.
        replies = libc.calloc(count, ctypes.sizeof(PamResponse))
        if not replies:
            return 5  # PAM_BUF_ERR
        array = ctypes.cast(replies, ctypes.POINTER(PamResponse))
        for index in range(count):
            style = messages[index].contents.msg_style
            if style == 1:  # PAM_PROMPT_ECHO_OFF: la contraseña
                array[index].resp = libc.strdup(secret)
            elif style == 2:  # PAM_PROMPT_ECHO_ON: el usuario
                array[index].resp = libc.strdup(login_name)
        response[0] = array
        return 0

    libpam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(PamConv), ctypes.POINTER(ctypes.c_void_p)]
    libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
    callback = conv_func(conversation)
    conv = PamConv(callback, None)
    handle = ctypes.c_void_p()
    status = libpam.pam_start(LOGIN_PAM_SERVICE.encode("ascii"), login_name, ctypes.byref(conv), ctypes.byref(handle))
    if status != 0:
        raise RuntimeError(f"PAM no pudo iniciarse (código {status}).")
    try:
        status = libpam.pam_authenticate(handle, 0)
        if status == 0:
            # Una cuenta caducada o bloqueada no se identifica aunque la contraseña sea correcta.
            status = libpam.pam_acct_mgmt(handle, 0)
    finally:
        libpam.pam_end(handle, status)
    return status == 0


def _windows_logon(user: str, password: str) -> bool:
    """LogonUserW de advapi32 con un inicio de sesión de red, que comprueba la contraseña sin cargar el perfil."""
    from ctypes import wintypes
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.LogonUserW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.LogonUserW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    token = wintypes.HANDLE()
    # LOGON32_LOGON_NETWORK (3) y LOGON32_PROVIDER_DEFAULT (0).
    if not advapi32.LogonUserW(user, None, password, 3, 0, ctypes.byref(token)):
        return False
    kernel32.CloseHandle(token)
    return True


def check_system_password(user: str, password: str) -> bool:
    """Comprueba la contraseña de una cuenta del sistema."""
    return _windows_logon(user, password) if os.name == "nt" else _pam_authenticate(user, password)


def login(params: dict) -> dict:
    """
    zerochat/login: con la cuenta que ejecuta zerochat.py y su contraseña devuelve el token diario.
    Tras LOGIN_MAX_FAILURES fallos seguidos rechaza los intentos sin comprobarlos durante
    LOGIN_LOCKOUT_SECONDS; los intentos van de uno en uno.
    """
    global LOGIN_FAILURES, LOGIN_LOCKED_UNTIL
    user = params.get("user")
    password = params.get("password")
    if not all(isinstance(value, str) and 0 < len(value) <= LOGIN_MAX_FIELD_LENGTH for value in (user, password)):
        raise LoginError(-32602, f"user y password deben ser textos de 1 a {LOGIN_MAX_FIELD_LENGTH} caracteres.")
    with LOGIN_LOCK:
        remaining = LOGIN_LOCKED_UNTIL - time.monotonic()
        if remaining > 0:
            raise LoginError(LOGIN_LOCKED_CODE, "Demasiados intentos fallidos: espera para volver a intentarlo.", {"retryAfter": math.ceil(remaining)})
        account = system_account()
        same_account = user.casefold() == account.casefold() if os.name == "nt" else user == account
        # La contraseña se comprueba también con otro usuario, para que la respuesta no delate la cuenta.
        valid = check_system_password(account, password)
        if not (valid and same_account):
            LOGIN_FAILURES += 1
            if LOGIN_FAILURES >= LOGIN_MAX_FAILURES:
                LOGIN_FAILURES = 0
                LOGIN_LOCKED_UNTIL = time.monotonic() + LOGIN_LOCKOUT_SECONDS
            raise LoginError(LOGIN_FAILED_CODE, "Usuario o contraseña incorrectos.")
        LOGIN_FAILURES = 0
    return {"token": current_session_token()}
