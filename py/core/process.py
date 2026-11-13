"""Procesos del sistema: si siguen vivos, su huella de arranque y la terminación de su árbol."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import time
from pathlib import Path

from core.environment import DETECTED_OS


def _kill_process_tree(target: subprocess.Popen | int, *, grace_seconds: float = 0.0) -> None:
    """
    Termina un proceso y sus descendientes: su grupo POSIX si lo encabeza (los hijos de zerochat arrancan
    en una sesión propia) o su árbol en Windows, donde TerminateProcess solo alcanzaría al hijo directo y
    npm.cmd o npx dejarían vivo a node. Con grace_seconds se pide primero que termine (SIGTERM) y solo se
    fuerza si sigue vivo. Un Popen ya terminado no se toca: su PID podría ser ya de otro proceso.
    """
    proc = target if isinstance(target, subprocess.Popen) else None
    pid = proc.pid if proc else target
    if proc is not None and proc.poll() is not None:
        return
    if proc is None and (not _pid_alive(pid) or pid == os.getpid()):
        return
    try:
        if DETECTED_OS == "windows":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        elif hasattr(os, "killpg") and hasattr(os, "getpgid"):
            send = os.killpg if os.getpgid(pid) == pid else os.kill
            if grace_seconds > 0:
                send(pid, signal.SIGTERM)
                time.sleep(grace_seconds)
                if not _pid_alive(pid):
                    return
            send(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except (OSError, AttributeError):
            pass


def _windows_kernel32():
    """kernel32 con los prototipos que usan la huella de arranque y la comprobación de vida de un proceso."""
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32


# PROCESS_QUERY_LIMITED_INFORMATION: basta para leer la hora de creación y el código de salida.
_WINDOWS_PROCESS_QUERY = 0x1000


def _windows_process_start_token(pid: int) -> str | None:
    """En Windows la huella es la hora de creación del proceso (GetProcessTimes)."""
    from ctypes import wintypes
    kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(_WINDOWS_PROCESS_QUERY, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def _process_start_token(pid: int) -> str | None:
    """Huella del arranque de un proceso: distingue al original de otro que reciba el mismo PID."""
    if os.name == "nt":
        return _windows_process_start_token(pid)
    try:
        if Path(f"/proc/{pid}/stat").is_file():
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
            # El nombre del proceso va entre paréntesis y puede contener espacios.
            return stat.rsplit(")", 1)[1].split()[19]
        result = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return result.stdout.strip() or None
    except (OSError, IndexError, subprocess.SubprocessError):
        return None


def _windows_pid_alive(pid: int) -> bool:
    """En Windows, os.kill(pid, 0) no comprueba nada: envía Ctrl+C a la consola de ese proceso."""
    from ctypes import wintypes
    kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(_WINDOWS_PROCESS_QUERY, False, pid)
    if not handle:
        return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: existe, pero es de otra cuenta  # pyright: ignore[reportAttributeAccessIssue] (solo en Windows)
    try:
        exit_code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True
