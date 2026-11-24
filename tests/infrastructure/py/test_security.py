import os
import sqlite3
import unittest
import unittest.mock
from pathlib import Path

from backend import use_data_dir, use_project, zerochat


# Las pruebas preparan y leen el estado por el mismo contrato que la RPC (import_state/export_state),
# con el directorio actual como contexto, igual que la RPC.
def cwd():
    return zerochat.project_context()
def set_allow_all(controller, allow_all, ctx=None):
    controller.import_state({"allowAll": allow_all}, ctx or cwd())


def allow_all_of(controller, ctx=None):
    return controller.export_state(ctx or cwd())["allowAll"]


def set_rules(controller, rules, ctx=None):
    controller.import_state({"directoryRules": rules}, ctx)


def rules_of(controller, ctx=None):
    return controller.export_state(ctx)["directoryRules"]


def set_tool(controller, tool_id, policy, scope=zerochat.SCOPE_PERMANENT):
    patch = {"tools": {tool_id: {"policy": policy}}}
    if scope == zerochat.SCOPE_SESSION:
        controller.apply_session_overlay(patch, cwd())
    else:
        controller.import_state(patch, cwd())


def set_server(controller, server_id, policy):
    controller.import_state({"servers": {server_id: {"policy": policy}}}, cwd())


def revoke(controller, kind, item_id):
    controller.import_state({kind: {item_id: None}}, cwd())


def tool_entry(controller, tool_id, ctx=None):
    return controller.export_state(ctx or cwd())["tools"].get(tool_id)


def challenges(controller, ctx=None):
    """Retos pendientes de la sesión del proyecto."""
    return controller._session(ctx or cwd()).challenges


def server_entry(controller, server_id):
    return controller.export_state(cwd())["servers"].get(server_id)


def stored(kind):
    """Entradas permanentes guardadas en SQLite, sin la capa de sesión."""
    global_data, _ = zerochat.get_security_policy_data(cwd().key)
    return (global_data or {}).get(kind) or {}


def set_patterns(controller, *patterns, project_patterns=None):
    controller.import_state(
        {"commandPatterns": {"global": list(patterns), **({"project": list(project_patterns)} if project_patterns is not None else {})}},
        cwd(),
    )


def saved_patterns():
    """Patrones de comando guardados en SQLite, sin los de sesión."""
    with zerochat.open_storage() as conn:
        rows = conn.execute("SELECT id, data_json FROM security_policies;").fetchall()
    result: dict = {}
    for row in rows:
        data = zerochat.json.loads(row["data_json"])
        if row["id"] == zerochat.GLOBAL_SECURITY_POLICY_ID and data.get("commandPatterns"):
            result["global"] = data["commandPatterns"]
        elif row["id"].startswith(zerochat.PROJECT_KEY_PREFIX) and data.get("commandPatterns"):
            key = row["id"][len(zerochat.PROJECT_KEY_PREFIX):]
            result.setdefault("projects", {})[key] = data["commandPatterns"]
    if "projects" in result:
        result.setdefault("global", [])
    return result


class SecurityContextTest(unittest.TestCase):
    def test_resolve_path_inside_workspace_and_rejects_references_and_escapes(self):
        base_dir = use_data_dir(self)
        workspace = base_dir / "workspace"
        workspace.mkdir()
        ctx = zerochat.SecurityContext(workspace_dir=workspace)

        self.assertEqual(ctx.resolve_path("file.txt"), (workspace / "file.txt").resolve())
        for unresolved in ("~/secret", "$HOME/secret", "${SECRET}/file", "path\0evil"):
            self.assertIsNone(ctx.resolve_path(unresolved), unresolved)


class ControllerTestCase(unittest.TestCase):
    """Directorio de datos propio, un proyecto y un controlador nuevo por prueba."""

    def setUp(self):
        self.base_dir = use_data_dir(self)
        self.workspace = self.base_dir / "proj"
        self.workspace.mkdir()
        self.norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        # El proyecto de la prueba es también el del servidor: cwd() y self.ctx comparten sesión.
        self.ctx = use_project(self, self.workspace)
        self.controller = zerochat.AccessController()

    def evaluate(self, tool, args=None, ctx=None, **kwargs):
        return self.controller.evaluate_authorization(tool, args or {}, ctx or self.ctx, **kwargs)


class HandlerTestCase(ControllerTestCase):
    """Pruebas por las RPC del servidor, que usan el controlador global con su sesión limpia."""

    def setUp(self):
        super().setUp()
        self.controller = zerochat.ACCESS_CONTROLLER
        self.controller.clear_session()
        self.addCleanup(self.controller.clear_session)

    def call_local(self, name, arguments, **extra):
        res, err, _ = zerochat.dispatch_local("tools/call", {"name": name, "arguments": arguments, **extra}, cwd())
        self.assertIsNone(err)
        return res

    def authorize(self, challenge_id, decision, **extra):
        res, err, _ = zerochat.dispatch_security("zerochat/security/authorize", {
            "challengeId": challenge_id, "decision": decision, **extra
        }, cwd())
        return res, err

    def command_challenge(self, command):
        gate = self.call_local("run_command", {"command": command})
        self.assertTrue(gate.get("requiresAuthorization"), gate)
        return gate

    def status(self, command, ctx=None):
        cwd_ctx = ctx or cwd()
        return self.controller.evaluate_authorization("run_command", {"command": command}, cwd_ctx).status


class PolicyEvaluationTest(ControllerTestCase):
    def test_policy_precedence(self):
        dec = self.evaluate("run_command", {"command": "cat /etc/passwd"})
        self.assertEqual((dec.status, dec.requires_approval), ("ask", True))

        set_allow_all(self.controller, True)
        dec = self.evaluate("run_command", {"command": "rm -rf /"})
        self.assertEqual((dec.status, dec.reason), ("allow", "project_allow_all"))

        # allowAll es por proyecto: otro proyecto sigue gobernado por sus reglas RWX y confirmando fuera
        other_ctx = zerochat.SecurityContext(workspace_dir=(self.base_dir / "other").resolve())
        self.assertFalse(allow_all_of(self.controller, other_ctx))
        self.assertEqual(self.evaluate("run_command", {"command": "cat /etc/passwd"}, other_ctx).status, "ask")

        # Una denegación concreta prevalece sobre allowAll
        set_tool(self.controller, "run_command", zerochat.POLICY_DENY)
        dec = self.evaluate("run_command", {"command": "echo 1"})
        self.assertEqual((dec.status, dec.reason), ("deny", "granular_deny_rule"))
        set_server(self.controller, "srv1", zerochat.POLICY_DENY)
        dec = self.evaluate("custom_tool", server_id="srv1")
        self.assertEqual((dec.status, dec.reason), ("deny", "server_deny_rule"))

    def test_directory_rules_real_path_symlinks_and_relative_escapes(self):
        set_rules(self.controller, [f"R:{self.norm_ws}/docs/**", f"W:{self.norm_ws}/src/**"], self.ctx)
        self.assertTrue(self.evaluate("read_file", {"path": f"{self.norm_ws}/docs/readme.md"}).allowed)
        self.assertEqual(self.evaluate("write_file", {"path": f"{self.norm_ws}/docs/readme.md"}).status, "ask")
        self.assertTrue(self.evaluate("write_file", {"path": f"{self.norm_ws}/src/main.py"}).allowed)

        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)

        # Enlace dentro del proyecto que apunta fuera: pide confirmación
        outside_dir = self.base_dir / "outside_dir"
        outside_dir.mkdir()
        (outside_dir / "secret.txt").write_text("secret")
        link_out = self.workspace / "link_out"
        link_out.symlink_to(outside_dir, target_is_directory=True)
        for tool, target in (("read_file", str(link_out / "secret.txt")), ("read_file", "link_out/secret.txt"),
                             ("write_file", str(link_out / "new.txt")), ("write_file", "link_out/new.txt")):
            self.assertEqual(self.evaluate(tool, {"path": target}).status, "ask", target)

        # Regla cuya base es un enlace (/link/** -> /real): permite /real/x y /link/x
        real_dir = self.base_dir / "real_dir"
        real_dir.mkdir()
        link_to_real = self.base_dir / "link_to_real"
        link_to_real.symlink_to(real_dir, target_is_directory=True)
        norm_link = zerochat.normalize_directory_path(str(link_to_real))
        norm_real = zerochat.normalize_directory_path(str(real_dir))
        set_rules(self.controller, [f"RW:{norm_link}/**"], self.ctx)
        for tool in ("read_file", "write_file"):
            self.assertTrue(self.evaluate(tool, {"path": f"{norm_real}/x.txt"}).allowed)
            self.assertTrue(self.evaluate(tool, {"path": f"{norm_link}/x.txt"}).allowed)

        # Ruta relativa con .. que sale del proyecto: pide confirmación si no hay regla, y se permite si la regla la cubre
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        for escape_path in ("../outside.txt", "sub/../../outside.txt", f"{self.norm_ws}/../outside.txt"):
            for tool in ("read_file", "write_file"):
                self.assertEqual(self.evaluate(tool, {"path": escape_path}).status, "ask", escape_path)
        norm_parent = zerochat.normalize_directory_path(str(self.base_dir.resolve()))
        set_rules(self.controller, [f"RW:{norm_parent}/**"], self.ctx)
        for parent_rel in ("../outside.txt", "sub/../../outside.txt"):
            for tool in ("read_file", "write_file"):
                self.assertTrue(self.evaluate(tool, {"path": parent_rel}).allowed, parent_rel)

    def test_default_rule_follows_the_project_and_is_never_stored(self):
        proj_a, proj_b = self.base_dir / "proj_a", self.base_dir / "proj_b"
        for proj in (proj_a, proj_b):
            proj.mkdir()
            (proj / "test.txt").write_text("hello", encoding="utf-8")
        ctx_a = zerochat.SecurityContext(workspace_dir=proj_a)
        ctx_b = zerochat.SecurityContext(workspace_dir=proj_b)
        file_a, file_b = str(proj_a / "test.txt"), str(proj_b / "test.txt")
        rule_a = f"RWX:{zerochat.normalize_directory_path(str(proj_a.resolve()))}/**"
        rule_b = self.controller.get_default_directory_rule(ctx_b)

        self.assertTrue(self.evaluate("read_file", {"path": file_a}, ctx_a).allowed)
        self.assertTrue(self.evaluate("write_file", {"path": file_a}, ctx_a).allowed)
        self.assertEqual(self.evaluate("read_file", {"path": file_b}, ctx_a).status, "ask")

        # La regla por defecto se entrega en directoryRules sin guardarse en SQLite hasta personalizarse
        exported_a = self.controller.export_state(ctx_a)
        self.assertEqual(exported_a["directoryRules"], [rule_a])
        self.controller.import_state({**exported_a, "directoryRules": [rule_a]}, context=ctx_a)
        self.assertIsNone(zerochat.get_security_policy_data(ctx_a.key)[1])

        # En el proyecto B rige su propia regla y A deja de estar autorizado
        self.assertTrue(self.evaluate("write_file", {"path": file_b}, ctx_b).allowed)
        self.assertEqual(self.evaluate("read_file", {"path": file_a}, ctx_b).status, "ask")

        # Desde B, la regla de A se guarda solo para B y no se filtra a A
        set_rules(self.controller, [rule_b, rule_a], ctx_b)
        self.assertEqual((zerochat.get_security_policy_data(ctx_b.key)[1] or {}).get("directoryRules"), [rule_b, rule_a])
        self.assertIsNone(zerochat.get_security_policy_data(ctx_a.key)[1])
        self.assertEqual(self.controller.export_state(ctx_a)["directoryRules"], [rule_a])
        self.assertEqual(self.evaluate("read_file", {"path": file_b}, ctx_a).status, "ask")

        # Vaciar las reglas de B deja al proyecto sin permisos automáticos
        self.controller.apply_session_overlay({"directoryRules": [f"R:{zerochat.normalize_directory_path(str(proj_b.resolve()))}/**"]}, ctx_a)
        set_rules(self.controller, [], ctx_b)
        self.assertEqual(self.controller.export_state(ctx_b)["directoryRules"], [])
        self.assertEqual(self.evaluate("read_file", {"path": file_b}, ctx_b).status, "ask")
        self.assertTrue(self.evaluate("read_file", {"path": file_b}, ctx_a).allowed)

        # Editar a R: deja el proyecto en solo lectura real incluso con patrones
        set_patterns(self.controller, "ls *")
        set_rules(self.controller, [f"R:{zerochat.normalize_directory_path(str(proj_b.resolve()))}/**"], ctx_b)
        self.assertTrue(self.evaluate("read_file", {"path": file_b}, ctx_b).allowed)
        self.assertEqual(self.evaluate("write_file", {"path": file_b}, ctx_b).status, "ask")
        self.assertEqual(self.evaluate("run_command", {"command": "ls"}, ctx_b).reason, "command_directory_without_execute")

        # Sin X (RW:) permite leer/escribir ficheros pero impide run_command; con RX: permite leer y ejecutar
        set_rules(self.controller, [f"RW:{zerochat.normalize_directory_path(str(proj_b.resolve()))}/**"], ctx_b)
        self.assertTrue(self.evaluate("write_file", {"path": file_b}, ctx_b).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": "ls"}, ctx_b).reason, "command_directory_without_execute")
        set_rules(self.controller, [f"RX:{zerochat.normalize_directory_path(str(proj_b.resolve()))}/**"], ctx_b)
        self.assertEqual(self.evaluate("write_file", {"path": file_b}, ctx_b).status, "ask")
        self.assertTrue(self.evaluate("run_command", {"command": "ls"}, ctx_b).allowed)

    def test_ask_with_rwx_allows_local_commands_and_paths_but_not_references_outside(self):
        self.assertFalse(allow_all_of(self.controller, self.ctx))

        set_rules(self.controller, [f"RWX:{self.norm_ws}/**"], self.ctx)
        self.assertTrue(self.evaluate("read_file", {"path": f"{self.norm_ws}/inside.txt"}).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": "ls -la | grep test"}).allowed)
        # Cada subcomando se valida por separado; tras una tubería, solo un filtro
        self.assertTrue(self.evaluate("run_command", {"command": "npm test && ls -la | grep x"}).allowed)
        for command in ("npm test && cat /etc/passwd", "cat script.txt | sh", "npm test; sudo ls"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).status, "ask", command)
        for path in ("/etc/passwd", "~/.ssh/id_rsa", "$HOME/.bashrc", "../outside.txt", "/workspace/../etc/passwd"):
            self.assertEqual(self.evaluate("read_file", {"path": path}).status, "ask", path)
        self.assertEqual(self.evaluate("run_command", {"command": "sudo apt update"}).status, "ask")
        # Una orden global se reconoce por el ejecutable que verá la shell, no por el texto del comando
        for command in ("'sudo' ls", '"sudo" ls', "s\\udo ls", "/usr/bin/sudo ls", "env -i sudo ls", "x=1 command sudo ls",
                        "nice -n 5 doas ls", "pkexec ls", "run0 ls", "mkfs.ext4 disk.img", "sh -c 'sudo ls'",
                        "sh -c 's\\udo ls'", "SUDO ls", '"su""do" ls', "sudo"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).status, "ask", command)
        for command in ("npm run sudoku", "grep -r pseudo src", "cat mkfs-notes.txt", "ls systemctl-backup"):
            self.assertTrue(self.evaluate("run_command", {"command": command}).allowed, command)
        # Un patrón guardado es una vía más de permitir: no hace más estrictas las reglas RWX del proyecto
        set_patterns(self.controller, "git status *")
        self.assertEqual(self.evaluate("run_command", {"command": "npm test"}).reason, "directory_rule_allow")

        # Una regla RW de proyecto amplía los argumentos de ruta de run_command (R: solo lecturas de fichero) y RWX permite cd+ejecución
        extra_ro = self.base_dir / "extra_ro"
        extra_rw = self.base_dir / "extra_rw"
        extra_ro.mkdir()
        extra_rw.mkdir()
        norm_ro = zerochat.normalize_directory_path(str(extra_ro.resolve()))
        norm_rw = zerochat.normalize_directory_path(str(extra_rw.resolve()))
        set_rules(self.controller, [f"RWX:{self.norm_ws}/**", f"R:{norm_ro}/**", f"RW:{norm_rw}/**"], self.ctx)
        self.assertTrue(self.evaluate("read_file", {"path": f"{norm_ro}/a.txt"}).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": f"ls {norm_ro}"}).status, "ask")
        self.assertTrue(self.evaluate("run_command", {"command": f"ls {norm_rw}"}).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": f"git -C {norm_rw} status"}).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": f"cd {norm_rw} && ls ../extra_rw/x"}).reason, "command_directory_without_execute")
        set_rules(self.controller, [f"RWX:{self.norm_ws}/**", f"R:{norm_ro}/**", f"RWX:{norm_rw}/**"], self.ctx)
        self.assertTrue(self.evaluate("run_command", {"command": f"cd {norm_rw} && ls ../extra_rw/x"}).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": f"python3 -c \"import os; os.system('cat {norm_rw}/x')\""}).status, "ask")
        self.assertEqual(self.evaluate("run_command", {"command": f"ls {norm_rw}/../extra_ro"}).status, "ask")

        # RWX:/** desbloquea todo el árbol y comandos compuestos solo en ese proyecto
        other = self.base_dir / "restricted_other"
        other.mkdir()
        ctx_other = zerochat.SecurityContext(other.resolve())
        set_rules(self.controller, ["RWX:/**"], self.ctx)
        self.assertTrue(self.evaluate("run_command", {"command": "cat /etc/passwd > /tmp/out && $(true)"}).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": "cat /etc/passwd"}, ctx_other).status, "ask")

    def test_compound_commands_are_validated_by_subcommand(self):
        set_patterns(self.controller, "git *", "npm run *")
        allowed = ("git status && git log", "npm run test:unit && npm run test:integration", "git log 2>&1 | git status",
                   'git commit -m "a && b; c | d"')
        for command in allowed:
            self.assertTrue(self.evaluate("run_command", {"command": command}).allowed, command)
        for command, offer in (("git status && cat /etc/passwd", "cat /etc/passwd"), ("git log | sh", "sh *"), ("sudo make; git status", "sudo make *")):
            dec = self.evaluate("run_command", {"command": command})
            self.assertEqual((dec.reason, dec.rule_offer["command"]), ("command_outside_allowed_patterns", offer), command)
        # Lo que no se puede validar por partes pide permiso sin oferta de patrón
        unsplittable = ("git log > out.txt", "git log $(rm x)", "git log `rm x`", "git status & rm x", "(git status)",
                        "if git status; then rm x; fi", "git status &&", "git log\nrm x", 'git log "a')
        for command in unsplittable:
            dec = self.evaluate("run_command", {"command": command})
            self.assertEqual((dec.reason, dec.rule_offer), ("command_chaining_requires_approval", None), command)
        self.assertFalse(zerochat.matches_command_pattern("git status && ls", "git *"))

    def test_every_cd_must_be_covered_by_directory_rules(self):
        set_rules(self.controller, [f"RWX:{self.norm_ws}/**"], self.ctx)
        set_patterns(self.controller, "git *", "ls *")
        for command in (f"cd {self.norm_ws} && git status", f"cd {self.norm_ws} ; git status; ls",
                        "cd src && ls && cd .. && git status", 'cd "a dir" && ls'):
            self.assertTrue(self.evaluate("run_command", {"command": command}).allowed, command)
        # La carpeta se acumula: tras 'cd src', '..' y '..' salen del proyecto
        for command in ("cd /etc && git status", "git status && cd /etc && ls", "cd src && cd .. && cd .. && ls"):
            dec = self.evaluate("run_command", {"command": command})
            self.assertEqual((dec.reason, dec.rule_offer), ("command_directory_outside_rules", None), command)
        # Un cd que solo la shell resuelve o que va escondido no se valida por partes
        for command in ("cd ~ && ls", "cd $HOME && ls", "cd - && ls", "cd && ls", "cd s* && ls", "x=1 cd /etc && ls",
                        "command cd /etc; ls", "Set-Location /etc; ls", "pushd /etc && ls"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).reason, "command_chaining_requires_approval", command)

    def test_rule_offer_for_commands_and_directories(self):
        set_rules(self.controller, [f"RX:{self.norm_ws}/**"], self.ctx)
        offers = {
            "sudo ./myui --port 8080": "sudo *",
            f"cd {self.norm_ws} && sudo git status": "sudo git *",  # el cd no forma parte del patrón
            "sudo npm a && sudo npm b": "sudo npm *",              # un patrón común a los subcomandos
            "git log | tee -a out.log": "tee *",                    # una opción no es un subcomando
        }
        for command, pattern in offers.items():
            offer = self.evaluate("run_command", {"command": command}).rule_offer
            self.assertEqual((offer["type"], offer["command"]), ("command", pattern), command)
        # Sin patrón común a los subcomandos, o con un cd fuera de las reglas, no hay oferta
        for command in ("sudo npm test && cat /etc/hosts", "cd /tmp && git status"):
            self.assertIsNone(self.evaluate("run_command", {"command": command}).rule_offer, command)

        offer = self.evaluate("write_file", {"path": f"{self.norm_ws}/src/app.py"}).rule_offer
        self.assertEqual((offer["type"], offer["access"], offer["directoryRule"]), ("directory", "W", f"W:{self.norm_ws}/src/**"))
        self.assertIsNone(self.evaluate("read_file", {"path": "~/.ssh/id_rsa"}).rule_offer)
        # Las herramientas externas no se autorizan por carpeta
        dec = self.evaluate("srv__write_file", {"path": "/tmp/x.txt"}, server_id="srv")
        self.assertEqual((dec.status, dec.rule_offer), ("ask", None))


class PolicyStateTest(ControllerTestCase):
    def test_partial_patch_update_and_revocation(self):
        set_tool(self.controller, "t1", zerochat.POLICY_ALLOW)
        set_tool(self.controller, "t2", zerochat.POLICY_DENY)
        set_tool(self.controller, "t_sess", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        set_server(self.controller, "s1", zerochat.POLICY_ALLOW)
        set_rules(self.controller, [f"R:{self.norm_ws}/docs/**"], self.ctx)

        # Una clave ausente no cambia nada; null revoca permanentes y de sesión; addDirectoryRules añade sin duplicar
        res = self.controller.import_state({
            "tools": {"t3": {"policy": "allow"}},
            "addDirectoryRules": [f"RW:{self.norm_ws}/.zerochat", f"R:{self.norm_ws}/docs/**"]
        }, self.ctx)
        self.assertEqual(set(res["tools"]), {"t1", "t2", "t3", "t_sess"})
        self.assertEqual((list(res["servers"]), res["directoryRules"]),
                         (["s1"], [f"R:{self.norm_ws}/docs/**", f"RW:{self.norm_ws}/.zerochat"]))
        res = self.controller.import_state({"tools": {"t1": None, "t_sess": None}}, self.ctx)
        self.assertEqual(set(res["tools"]), {"t2", "t3"})
        res = self.controller.import_state({"servers": {"s1": None, "s2": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(list(res["servers"]), ["s2"])

        # Las RPC aplican el mismo parche y devuelven el estado completo, igual que initialize
        rpc, err, _ = zerochat.dispatch_security("zerochat/security/update", {"tools": {"t4": {"policy": "allow"}}}, cwd())
        self.assertIsNone(err)
        self.assertEqual(set(rpc["policies"]["tools"]), {"t2", "t3", "t4"})
        init, err, _ = zerochat.dispatch_local("initialize", {}, cwd())
        self.assertIsNone(err)
        self.assertEqual(init["policies"]["tools"].keys(), rpc["policies"]["tools"].keys())

    def test_invalid_patch_changes_nothing(self):
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        initial = self.controller.export_state(self.ctx)
        for payload in ({"allowAll": True, "directoryRules": ["INVALID_NO_PREFIX_RULE"]},
                        {"allowAll": "yes"},
                        {"addDirectoryRules": ["INVALID"]},
                        {"tools": {"tool_a": {"policy": "unsupported_policy"}}},
                        {"servers": {"srv_a": {"policy": "invalid"}}}):
            with self.assertRaises(ValueError, msg=repr(payload)):
                self.controller.import_state(payload, self.ctx)
            self.assertEqual(self.controller.export_state(self.ctx), initial)

    def test_max_policy_entries_exact_boundary(self):
        limit = zerochat.MAX_POLICY_ENTRIES
        self.controller.import_state({"tools": {f"tool_{i}": {"policy": "allow"} for i in range(limit)}}, self.ctx)
        self.assertEqual(len(stored("tools")), limit)
        with self.assertRaisesRegex(ValueError, "supera el máximo permitido"):
            self.controller.import_state({"tools": {f"tool_{i}": {"policy": "allow"} for i in range(limit + 1)}}, self.ctx)
        # La capa de sesión tiene el mismo tope
        self.controller.apply_session_overlay({"tools": {f"s_{i}": {"policy": "allow"} for i in range(limit)}}, self.ctx)
        with self.assertRaisesRegex(ValueError, "supera el máximo permitido"):
            self.controller.apply_session_overlay({"tools": {f"s_{i}": {"policy": "allow"} for i in range(limit + 1)}}, self.ctx)

    def test_two_controllers_share_state_through_sqlite_and_preserve_granted_at(self):
        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_000.0):
            first = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
        self.assertEqual(first["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)
        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_100.0):
            same = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
            changed = self.controller.import_state({"tools": {"t_g": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(same["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)
        self.assertEqual(changed["tools"]["t_g"]["grantedAt"], 1_700_000_100_000)

        # En memoria solo hay sesión y retos pendientes: el estado permanente vive en SQLite
        self.assertEqual(set(self.controller.__dict__), {"_lock", "sessions"})
        controller_b = zerochat.AccessController()
        set_allow_all(self.controller, True)
        set_tool(self.controller, "tool_shared", zerochat.POLICY_ALLOW)
        set_server(self.controller, "srv_shared", zerochat.POLICY_ALLOW)
        self.assertTrue(allow_all_of(controller_b))
        self.assertEqual(tool_entry(controller_b, "tool_shared")["policy"], zerochat.POLICY_ALLOW)
        self.assertEqual(server_entry(controller_b, "srv_shared")["policy"], zerochat.POLICY_ALLOW)
        revoke(controller_b, "tools", "tool_shared")
        self.assertIsNone(tool_entry(self.controller, "tool_shared"))

    def decide(self, tool, decision, **kwargs):
        ch = self.controller.create_challenge(tool, {}, self.evaluate(tool), context=self.ctx)
        return self.controller.authorize_challenge(ch["id"], decision, context=self.ctx, **kwargs)

    def test_decisions_keep_session_in_memory_and_persist_permanent_atomically(self):
        self.decide("tool_x", "allow_session")
        self.assertEqual(tool_entry(self.controller, "tool_x")["scope"], "session")
        self.assertNotIn("tool_x", stored("tools"))

        self.decide("tool_y", "allow_always", directory_rule=f"R:{self.norm_ws}/extra/**")
        self.assertIn("tool_y", stored("tools"))
        self.assertIn(f"R:{self.norm_ws}/extra/**", rules_of(self.controller, self.ctx))

        self.controller.clear_session()
        self.assertIsNone(tool_entry(self.controller, "tool_x"))
        self.assertIsNotNone(tool_entry(self.controller, "tool_y"))

        # Herramienta + regla en el borde MAX_POLICY_ENTRIES se guardan en una sola transacción
        limit = zerochat.MAX_POLICY_ENTRIES
        self.controller.import_state({
            "directoryRules": [],
            "tools": {"tool_y": None, **{f"fill_{i}": {"policy": "allow"} for i in range(limit - 1)}}
        }, self.ctx)
        with self.assertRaises(ValueError):
            self.decide("tool_tx", "allow_always", directory_rule=f"R:{self.norm_ws}/extra/**")
        self.assertIsNone(tool_entry(self.controller, "tool_tx"))
        self.assertEqual(rules_of(self.controller, self.ctx), [])
        self.decide("tool_tx", "allow_always")
        self.assertEqual(tool_entry(self.controller, "tool_tx")["policy"], zerochat.POLICY_ALLOW)

    def test_storage_failure_or_corrupt_policies_fail_visibly_and_are_not_overwritten(self):
        initial = self.controller.export_state(self.ctx)
        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")):
            res, err, _ = zerochat.dispatch_security("zerochat/security/update", {
                "allowAll": True, "tools": {"my_tool": {"policy": "allow"}}
            }, self.ctx)
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32603)
        self.assertIn("database is locked", err["message"])
        self.assertEqual(self.controller.export_state(self.ctx), initial)

        with zerochat.open_storage() as conn:
            conn.execute("INSERT OR REPLACE INTO security_policies (id, data_json, updated_at) VALUES (?, '{corrupt', 0);", (zerochat.GLOBAL_SECURITY_POLICY_ID,))
            conn.commit()
        res, err, _ = zerochat.dispatch_security("zerochat/security/update", {"allowAll": True}, cwd())
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32603)
        self.assertIn("corruptas", err["message"])
        with zerochat.open_storage() as conn:
            raw = conn.execute("SELECT data_json FROM security_policies WHERE id = ?;", (zerochat.GLOBAL_SECURITY_POLICY_ID,)).fetchone()["data_json"]
        self.assertEqual(raw, "{corrupt")
        with self.assertRaises(RuntimeError):
            self.evaluate("read_file", {"path": "x.txt"})


class ChallengeTest(HandlerTestCase):
    def test_challenge_is_single_use_and_tools_call_ignores_challenge_ids(self):
        set_rules(self.controller, [], self.ctx)
        gate = self.call_local("get_diagnostics", {"path": str(self.base_dir)})
        cid = gate["challengeId"]
        res, err = self.authorize(cid, "allow_session")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        res, err = self.authorize(cid, "allow_session")
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32002)

        # Un challengeId en tools/call no salta la evaluación de otra herramienta: emite un reto nuevo
        target = self.base_dir / "pwned.txt"
        gate = self.call_local("write_file", {"path": str(target), "content": "exploit"}, challengeId=cid, _meta={"challengeId": cid})
        self.assertTrue(gate.get("requiresAuthorization"))
        self.assertNotEqual(gate["challengeId"], cid)
        self.assertFalse(target.exists())

    def test_challenge_ttl_exact_boundary_and_cwd_change(self):
        base_sec = 1_700_000_000.0
        ttl_sec = zerochat.CHALLENGE_TTL_MS / 1000.0
        dec = self.evaluate("run_command", {"command": "echo ok"})
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec):
            ch_ok = self.controller.create_challenge("run_command", {"command": "echo ok"}, dec, context=cwd())
            ch_exp = self.controller.create_challenge("run_command", {"command": "echo expired"}, dec, context=cwd())
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec):
            res, err = self.authorize(ch_ok["id"], "allow_once")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec + 0.001):
            res, err = self.authorize(ch_exp["id"], "allow_always", commandPattern="echo *")
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertNotIn(ch_exp["id"], challenges(self.controller))
        self.assertEqual(saved_patterns(), {})

        # Un reto solo se resuelve desde su proyecto, que lo conserva pendiente
        own = cwd()
        ch_cwd = self.controller.create_challenge("run_command", {"command": "echo cwd"}, dec, context=own)
        other_dir = self.workspace / "subdir"
        other_dir.mkdir()
        use_project(self, other_dir)
        res, err = self.authorize(ch_cwd["id"], "allow_once")
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertIn(ch_cwd["id"], challenges(self.controller, own))

    def test_a_browser_is_used_by_one_conversation_until_it_stays_idle(self):
        self.addCleanup(setattr, zerochat, "BROWSER_LEASES", zerochat.BROWSER_LEASES)
        zerochat.BROWSER_LEASES = zerochat.BrowserLease()
        patcher = unittest.mock.patch.dict(zerochat.LOCAL_TOOL_HANDLERS, {"browser_action": lambda **_: '{"success": true}'})
        patcher.start()
        self.addCleanup(patcher.stop)
        navigate = {"action": "navigate", "url": "https://example.com"}
        call = (lambda conversation: zerochat.dispatch_local(
            "tools/call", {"name": "browser_action", "arguments": navigate, "_meta": {"zerochatConversationId": conversation}}, cwd())[0])

        # Pedirlo no lo reserva: lo ocupa la conversación que llega a ejecutar, también tras un reto
        gate_b, gate_a = call("conv-b"), call("conv-a")
        self.assertTrue(gate_b["requiresAuthorization"] and gate_a["requiresAuthorization"])
        self.assertFalse(self.authorize(gate_a["challengeId"], "allow_session")[0]["result"]["isError"])
        busy = self.authorize(gate_b["challengeId"], "allow_once")[0]["result"]
        self.assertTrue(busy["isError"])
        self.assertIn("in use by another conversation", busy["content"][0]["text"])
        self.assertTrue(call("conv-b")["isError"])
        self.assertFalse(call("conv-a")["isError"], "La que lo usa sigue usándolo")
        # Playwright MCP es otro navegador, con su propia reserva
        set_server(self.controller, "playwright", zerochat.POLICY_ALLOW)
        result = {"content": [{"type": "text", "text": "ok"}], "isError": False}
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "server_of", return_value="playwright"), \
             unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value=result):
            external = (lambda conversation: zerochat.dispatch_local(
                "tools/call", {"name": "playwright__navigate", "arguments": {}, "_meta": {"zerochatConversationId": conversation}}, cwd())[0])
            self.assertFalse(external("conv-b")["isError"])
            self.assertTrue(external("conv-a")["isError"])
        # Sin uso durante el plazo queda libre
        with unittest.mock.patch.object(zerochat, "BROWSER_LEASE_IDLE_SECONDS", 0):
            self.assertFalse(call("conv-b")["isError"])
        # El plazo cuenta desde que la acción termina, no desde que empieza
        clock = [zerochat.time.monotonic()]
        with unittest.mock.patch.object(zerochat.time, "monotonic", lambda: clock[0]), \
             unittest.mock.patch.dict(zerochat.LOCAL_TOOL_HANDLERS, {"browser_action": lambda **_: clock.__setitem__(0, clock[0] + 50) or "{}"}):
            self.assertFalse(call("conv-b")["isError"])
            clock[0] += 20
            self.assertTrue(call("conv-a")["isError"], "70 s desde que empezó, 20 desde que acabó")

    def test_server_trust_covers_only_its_tools_and_never_local_ones(self):
        # Un reto de servicio MCP externo se ejecuta en el gestor externo al autorizarlo
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "server_of", return_value="sqlite"):
            gate, err, _ = zerochat.dispatch_local("tools/call", {"name": "sqlite_query", "arguments": {"sql": "SELECT 1"}}, cwd())
        self.assertIsNone(err)
        self.assertEqual(challenges(self.controller)[gate["challengeId"]]["origin"], "external")
        ext_res = {"content": [{"type": "text", "text": "external-output"}], "isError": False}
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value=ext_res) as external:
            res, err = self.authorize(gate["challengeId"], "allow_once")
        self.assertIsNone(err)
        self.assertEqual(res["result"]["content"][0]["text"], "external-output")
        external.assert_called_once_with("sqlite_query", {"sql": "SELECT 1"})

        set_server(self.controller, "playwright", zerochat.POLICY_ALLOW)
        result = {"content": [{"type": "text", "text": "ok"}], "isError": False}
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "server_of", side_effect=lambda name: name.split("__")[0]), \
             unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value=result) as external:
            res, err, _ = zerochat.dispatch_local("tools/call", {"name": "playwright__x", "arguments": {}}, cwd())
            self.assertIsNone(err)
            self.assertFalse(res.get("requiresAuthorization", False))
            res, err, _ = zerochat.dispatch_local("tools/call", {"name": "otro__y", "arguments": {}}, cwd())
            self.assertEqual((res.get("requiresAuthorization"), res["serverId"]), (True, "otro"))
        external.assert_called_once_with("playwright__x", {})

        # allow_server_always sobre una herramienta local se rechaza y no añade servidores
        revoke(self.controller, "servers", "playwright")
        gate = self.command_challenge("cat /etc/hosts")
        self.assertEqual(gate.get("serverId"), "")
        res, err = self.authorize(gate["challengeId"], "allow_server_always", serverId="mcp-proxy")
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertEqual(stored("servers"), {})

    def test_authorize_validates_rule_reports_storage_failure_and_forwards_job_key(self):
        ch = self.controller.create_challenge("custom_tool", {}, self.evaluate("custom_tool"), context=cwd())
        res, err = self.authorize(ch["id"], "allow_always", directoryRule="INVALID_RULE")
        self.assertEqual((res, err["code"]), (None, -32602))
        self.assertIn(ch["id"], challenges(self.controller))
        self.assertIsNone(tool_entry(self.controller, "custom_tool"))

        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")), \
                unittest.mock.patch.object(zerochat, "execute_tool") as execute:
            res, err = self.authorize(ch["id"], "allow_always")
        self.assertEqual((res, err["code"]), (None, -32603))
        self.assertIn("database is locked", err["message"])
        execute.assert_not_called()

        gate = self.call_local("run_command", {"command": "cat /etc/hosts"}, _meta={"zerochatJobKey": "inv-1"})
        self.assertEqual(gate["arguments"], {"command": "cat /etc/hosts"})
        with unittest.mock.patch.object(zerochat, "execute_tool", return_value=({"content": []}, None, "")) as execute:
            res, err = self.authorize(gate["challengeId"], "allow_once")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        execute.assert_called_once_with("local", "run_command", {"command": "cat /etc/hosts", "job_key": "inv-1"}, cwd(), "")


class ApprovedCallOnResumeTest(HandlerTestCase):
    """Al reanudar una ejecución en servidor, la llamada aprobada en la tarjeta pausada la contesta este servidor,
    porque la credencial del runner no puede resolver retos: solo esa llamada y una sola vez."""

    def run_session(self, decision, target):
        tool_decision = {"toolName": "write_file", "args": {"path": target, "content": "hola"}, "decision": decision}
        session = zerochat.RunSession(prompt="hola", tool_security={"tool_decision": tool_decision})
        patcher = unittest.mock.patch.object(zerochat, "RUN_SESSION", session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_solo_la_llamada_aprobada_y_una_sola_vez_y_una_denegacion_no_ejecuta_nada(self):
        target = str(self.base_dir / "approved.txt")
        other = str(self.base_dir / "other.txt")
        self.run_session("allow_once", target)
        # Otra llamada sin permiso no se ejecuta: vuelve a pausar la ejecución (needs_input), nunca un reto.
        paused_other = self.call_local("write_file", {"path": other, "content": "adios"})
        self.assertEqual((paused_other.get("awaitingApproval"), paused_other.get("arguments")), (True, {"path": other, "content": "adios"}))
        self.assertFalse((self.base_dir / "other.txt").exists())
        ran = self.call_local("write_file", {"content": "hola", "path": target})
        self.assertNotIn("requiresAuthorization", ran)
        self.assertNotIn("awaitingApproval", ran)
        self.assertEqual((self.base_dir / "approved.txt").read_text(encoding="utf-8"), "hola")
        self.assertTrue(self.call_local("write_file", {"path": target, "content": "hola"}).get("awaitingApproval"), "Solo una vez")

        self.run_session("deny", target)
        (self.base_dir / "approved.txt").unlink()
        self.assertTrue(self.call_local("write_file", {"path": target, "content": "hola"}).get("awaitingApproval"))
        self.assertFalse((self.base_dir / "approved.txt").exists())
        self.assertEqual(challenges(self.controller), {})


class CommandPatternTest(HandlerTestCase):
    def test_command_patterns_match_argument_by_argument(self):
        cases = [
            ("git status", "git status", True),
            ("git status", "git status -s", False),        # sin * el texto es exacto
            ("git status *", "git status", True),          # * final: cero o más argumentos
            ("git status *", "git status -s --long", True),
            ("git status *", "git statusx", False),
            ("git sta*", "git status", True),              # * dentro de una palabra
            ("git status", "git  status", True),           # los espacios no cuentan
            ("git status", "/usr/bin/git status", True),
            ("git * -n *", "git log -n 3", True),          # * suelto: un argumento
            ("rm /tmp/z/*", "rm /tmp/z/a.txt", True),
            ("rm /tmp/z/*", "rm '/tmp/z/a b'", True),      # comillas: un solo argumento
            ("rm /tmp/z/*", "rm /tmp/z/a /etc/passwd", False),
            ("rm /tmp/z/*", "rm /tmp/z/a/b", False),       # * no cruza /
            ("rm /tmp/z/*", "rm /tmp/z/..", False),
            ("rm /tmp/z/.*", "rm /tmp/z/..", False),
            ("rm /tmp/z/*", "rm /tmp/z/$X", False),        # lo que expande la shell
            ("rm /tmp/z/*", "rm /tmp/z/{a,b}", False),
            ("echo *", 'echo "sin cerrar', False),
            # Los argumentos del * final cumplen lo mismo que un comodín y no son rutas absolutas
            ("cat *", "cat ../../etc/passwd", False),
            ("cat *", "cat /etc/passwd", False),
            ("cat *", "cat ~/.ssh/id_rsa", False),
            ("cat *", "cat $HOME/.bashrc", False),
            ("cat *", "cat .?/passwd", False),             # glob que alcanza ..
            ("ls * *", "ls a ../x", False),
            ("git log *", "git log --output=/tmp/x", False),
            ("git log *", "git log HEAD~3 -- src/a.js", True),
        ]
        for pattern, command, expected in cases:
            with self.subTest(pattern=pattern, command=command):
                self.assertIs(zerochat.matches_command_pattern(command, pattern), expected)

    def test_command_patterns_are_validated_normalized_and_limited(self):
        set_patterns(self.controller, "git status *", "git  status  *", "git status", "git diff *", "git diff --stat")
        self.assertEqual(saved_patterns()["global"], ["git status *", "git diff *"])

        def store(global_patterns, project_patterns=None):
            self.controller.import_state({"commandPatterns": {"global": global_patterns, "project": project_patterns or []}}, self.ctx)

        for bad in (["git; rm"], ["git $(x)"], [""], ["*"], ["g* log"], ["git **"], ["git 'x'"], [3], "git"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store(bad)
        with self.assertRaises(ValueError):
            store([], ["git; rm"])
        # Guardar run_command sin patrones autorizaría cualquier comando; en la sesión sí se admite
        with self.assertRaisesRegex(ValueError, "allow_always_requires_command_pattern"):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow"}}}, self.ctx)
        self.controller.apply_session_overlay({"tools": {"run_command": {"policy": "allow"}}}, cwd())
        self.controller.clear_session()
        # Solo los patrones autorizan run_command de forma permanente, aunque la base de datos diga otra cosa
        zerochat.update_security_policy_data(
            cwd().key,
            lambda global_data, proj_data, _other: ({
                **(global_data or {}),
                "tools": {"run_command": {"policy": "allow", "scope": "permanent"}},
                "commandPatterns": [],
            }, proj_data),
        )
        self.assertEqual(self.evaluate("run_command", {"command": "sudo rm -rf build"}).status, "ask")

        # export_state solo expone {global, project, session} y update desde A no expone ni borra los de B
        proj_a = self.base_dir / "pat_a"
        proj_b = self.base_dir / "pat_b"
        proj_a.mkdir()
        proj_b.mkdir()
        ctx_a = zerochat.SecurityContext(workspace_dir=proj_a.resolve())
        ctx_b = zerochat.SecurityContext(workspace_dir=proj_b.resolve())
        self.controller.import_state({"commandPatterns": {"global": ["git status *"], "project": ["npm test *"]}}, ctx_b)
        exported_a = self.controller.import_state({"commandPatterns": {"global": ["git status *"], "project": ["pytest *"]}}, ctx_a)
        self.assertEqual(exported_a["commandPatterns"], {"global": ["git status *"], "project": ["pytest *"], "session": []})
        self.assertEqual(self.controller.export_state(ctx_b)["commandPatterns"], {"global": ["git status *"], "project": ["npm test *"], "session": []})
        # Vaciar patrones desde A elimina la clave de A en SQLite pero conserva intactos los de B
        self.controller.import_state({"commandPatterns": {"global": [], "project": []}}, ctx_a)
        self.assertEqual(saved_patterns(), {"global": [], "projects": {ctx_b.key: ["npm test *"]}})

        # El tope cuenta los patrones globales y los de todos los proyectos: N se acepta y N+1 no
        limit = zerochat.MAX_COMMAND_PATTERNS
        half = limit // 2
        self.controller.import_state({"commandPatterns": {"global": [], "project": [f"b{i}" for i in range(half)]}}, ctx_b)
        self.controller.import_state({"commandPatterns": {"global": [], "project": [f"a{i}" for i in range(limit - half)]}}, ctx_a)
        with self.assertRaisesRegex(ValueError, "máximo"):
            self.controller.import_state({"commandPatterns": {"global": [], "project": [f"a{i}" for i in range(limit - half + 1)]}}, ctx_a)
        self.assertEqual(len(saved_patterns()["projects"][ctx_b.key]), half)

    # Aprobar un reto ejecuta el comando pendiente: aquí se sustituye la ejecución para no lanzar sudo de verdad.
    @unittest.mock.patch.object(zerochat, "execute_tool", return_value=({"content": [], "isError": False}, None, ""))
    def test_command_grants_need_a_pattern_that_covers_the_challenge(self, execute_tool):
        gate = self.command_challenge("sudo echo hola mundo")
        cid = gate["challengeId"]
        self.assertEqual(gate["ruleOffer"]["command"], "sudo echo *")
        # Si el * no cubriría los argumentos (fuera del proyecto), se ofrece el comando exacto
        self.assertEqual(self.command_challenge("cat /etc/hosts")["ruleOffer"]["command"], "cat /etc/hosts")
        # En un comando compuesto el patrón tiene que cubrir alguno de sus subcomandos
        chained = self.command_challenge("sudo npm test:unit && sudo npm test:integration")
        self.assertEqual(chained["ruleOffer"]["command"], "sudo npm *")
        res, err = self.authorize(chained["challengeId"], "allow_session", commandPattern="sudo yarn *")
        self.assertEqual((res, err["code"]), (None, -32602))
        # 'sudo npm test*' cubre cada subcomando ('test:unit' es una sola palabra)
        res, err = self.authorize(chained["challengeId"], "allow_session", commandPattern="sudo npm test*")
        self.assertIsNone(err)
        rejected = (
            ("allow_always", {}, "allow_always_requires_command_pattern"),
            ("allow_project", {}, "allow_project_requires_command_pattern"),
            ("allow_always", {"commandPattern": "sudo echo adios *"}, None),
        )
        for decision, extra, message in rejected:
            res, err = self.authorize(cid, decision, **extra)
            self.assertEqual((res, err["code"]), (None, -32602), decision)
            if message:
                self.assertEqual(err["message"], message)
            self.assertIn(cid, challenges(self.controller))

        res, err = self.authorize(cid, "allow_always", commandPattern="sudo echo *")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        self.assertEqual(saved_patterns()["global"], ["sudo echo *"])
        self.assertEqual(execute_tool.call_args.args[1:3], ("run_command", {"command": "sudo echo hola mundo"}))
        self.assertEqual(self.status("sudo echo otra cosa"), "allow")
        self.assertEqual(self.status("sudo rm -rf /"), "ask")

    # Aprobar un reto ejecuta el comando pendiente: aquí se sustituye la ejecución para no lanzar sudo de verdad.
    @unittest.mock.patch.object(zerochat, "execute_tool", return_value=({"content": [], "isError": False}, None, ""))
    def test_command_pattern_scopes_session_project_and_global(self, execute_tool):
        other_project = zerochat.SecurityContext(workspace_dir=self.base_dir.resolve())
        project = zerochat.normalize_directory_path(str(zerochat.PROJECT_DIR))

        # Sesión: solo ese patrón, en memoria y sin guardarse
        res, err = self.authorize(self.command_challenge("sudo echo uno")["challengeId"], "allow_session", commandPattern="sudo echo uno *")
        self.assertIsNone(err)
        self.assertEqual((self.status("sudo echo uno dos"), self.status("sudo echo otro")), ("allow", "ask"))
        self.assertEqual(saved_patterns(), {})

        # Proyecto: guardado ligado al proyecto actual; en otro proyecto vuelve a preguntar
        res, err = self.authorize(self.command_challenge("sudo printf proyecto")["challengeId"], "allow_project", commandPattern="sudo printf *")
        self.assertIsNone(err)
        self.assertEqual(saved_patterns(), {"global": [], "projects": {project: ["sudo printf *"]}})
        self.assertEqual((self.status("sudo printf x"), self.status("sudo printf x", other_project)), ("allow", "ask"))
        # La escritura permanente no retira los patrones de sesión: se suman
        self.assertEqual(self.status("sudo echo uno dos"), "allow")

        # Global: vale en cualquier proyecto
        res, err = self.authorize(self.command_challenge("sudo true global")["challengeId"], "allow_always", commandPattern="sudo true *")
        self.assertIsNone(err)
        self.assertEqual(self.status("sudo true x", other_project), "allow")
        exported = self.controller.export_state(cwd())["commandPatterns"]
        self.assertEqual(exported, {"global": ["sudo true *"], "project": ["sudo printf *"], "session": ["sudo echo uno *"]})
        self.assertEqual(self.controller.export_state(other_project)["commandPatterns"], {"global": ["sudo true *"], "project": [], "session": []})

        # Al acabar la sesión solo quedan los permanentes, pero un snapshot de sesión exportado puede reaplicarse
        snapshot = self.controller.export_state(cwd())
        self.controller.clear_session()
        self.assertEqual([self.status(c) for c in ("sudo echo uno dos", "sudo printf x", "sudo true x")], ["ask", "allow", "allow"])
        self.controller.apply_session_overlay(snapshot, cwd())
        self.assertEqual(self.status("sudo echo uno dos"), "allow")
        self.assertEqual(execute_tool.call_count, 3)


class PowerShellCommandTest(ControllerTestCase):
    """En Windows run_command ejecuta PowerShell: los comandos se parten y se leen con su sintaxis."""

    def setUp(self):
        super().setUp()
        patcher = unittest.mock.patch.object(zerochat, "COMMAND_SHELL", "powershell")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_powershell_commands_split_with_its_quoting_and_operators(self):
        split = zerochat.split_command
        # La \ no escapa: "C:\" cierra la comilla y lo que sigue es otro subcomando (sh lo leería como un solo echo)
        self.assertEqual(split('echo "C:\\" ; Remove-Item src'), [("", 'echo "C:\\"'), (";", "Remove-Item src")])
        with unittest.mock.patch.object(zerochat, "COMMAND_SHELL", "posix"):
            self.assertIsNone(split('echo "C:\\" ; Remove-Item src'))
        # La comilla se repite dentro de comillas; las tipográficas valen como las ASCII
        self.assertEqual(zerochat.split_words("cat 'C:\\a b\\it''s.txt' \"x\"\"y\""), ["cat", "C:\\a b\\it's.txt", 'x"y'])
        self.assertEqual(zerochat.split_words("cat \u2018C:\\x y\u2019"), ["cat", "C:\\x y"])
        with self.assertRaises(ValueError):
            zerochat.split_words("cat 'C:\\x")
        # Bloques de script, comilla invertida, llamada con & y redirecciones a fichero no se validan por partes;
        # /dev/null es un fichero más y lo descartado va a $null
        for command in ("Invoke-Command { Remove-Item src }", "ls | % { $_ }", "echo `whoami`", "& .\\build.ps1",
                        "npm test > /dev/null", "npm test > out.txt"):
            self.assertIsNone(split(command), command)
        self.assertEqual(split("npm test 2>$null; npm run lint *>$null"), [("", "npm test"), (";", "npm run lint")])
        # PowerShell no distingue mayúsculas: CD también cambia de carpeta
        self.assertEqual(zerochat.cd_target("CD src"), "src")

    def test_powershell_paths_and_global_commands_need_approval(self):
        # Las rutas de Windows llegan enteras a las reglas de directorio (sh dejaba C:\x en C:x, que no es una ruta)
        self.assertEqual(zerochat.command_outside_references("Get-Content 'C:\\Users\\x\\a b.txt' C:\\Windows\\win.ini"),
                         ["C:\\Users\\x\\a b.txt", "C:\\Windows\\win.ini"])
        self.assertEqual(zerochat.command_outside_references("cat ..\\otro\\a.txt"), ["..\\otro\\a.txt"])
        for command in ("cat ..\\otro\\a.txt", "C:\\Windows\\System32\\sudo.exe ls", "runas /user:admin cmd",
                        "Start-Process pwsh -Verb RunAs", "Format-Volume -DriveLetter D", "Stop-Service wuauserv",
                        "npm test; Restart-Computer"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).status, "ask", command)
        for command in ("Get-ChildItem src", "cat .\\src\\a.txt", "npm test 2>$null", "git status; git log"):
            self.assertTrue(self.evaluate("run_command", {"command": command}).allowed, command)

    @unittest.skipUnless(os.name == "nt", "Solo Windows resuelve C:\\ como ruta absoluta")
    def test_windows_absolute_paths_outside_the_project_need_approval(self):
        for command in ("cat C:\\Windows\\win.ini", "Get-Content 'C:\\Windows\\System32\\drivers\\etc\\hosts'", "CD C:\\Windows"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).status, "ask", command)


class SessionLifecycleTest(HandlerTestCase):
    def test_reset_session_authorizations_applies_the_run_overlay_without_storing_it(self):
        set_allow_all(self.controller, False)
        set_tool(self.controller, "db_tool", zerochat.POLICY_DENY)
        self.addCleanup(setattr, zerochat, "RUN_SESSION", None)
        zerochat.RUN_SESSION = zerochat.RunSession(prompt="test", tool_security={
            "allowAll": True, "tools": {"custom_tool": {"policy": "allow"}},
            "directoryRules": [f"RWX:{zerochat.normalize_directory_path(str(zerochat.PROJECT_DIR))}/**", "RW:/test/**"]
        })
        zerochat.reset_session_authorizations()

        for tool in ("browser_action", "custom_tool"):
            self.assertEqual(tool_entry(self.controller, tool)["policy"], "allow", tool)
        for tool in ("read_file", "write_file", "edit_file", "run_command"):
            self.assertIsNone(tool_entry(self.controller, tool), tool)
        self.assertEqual(tool_entry(self.controller, "db_tool")["policy"], "deny")
        self.assertFalse(allow_all_of(self.controller))
        self.assertTrue(self.evaluate("custom_tool").allowed)
        self.assertTrue(self.evaluate("write_file", {"path": f"{self.norm_ws}/ok.txt"}).allowed)
        self.assertTrue(self.evaluate("write_file", {"path": "/test/ok.txt"}).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": "echo ok"}).allowed)

        # Fuera de las reglas del proyecto, en ejecución desatendida se pausa (needs_input) sin crear reto ni ejecutar
        outside_write = self.call_local("write_file", {"path": "/etc/passwd", "content": "x"})
        outside_cmd = self.call_local("run_command", {"command": "rm -rf /tmp/x"})
        self.assertEqual((outside_write.get("awaitingApproval"), outside_write.get("toolName"), outside_write.get("isError")), (True, "write_file", False))
        self.assertEqual((outside_cmd.get("awaitingApproval"), outside_cmd.get("toolName")), (True, "run_command"))
        self.assertNotIn("requiresAuthorization", outside_cmd)
        self.assertEqual(challenges(self.controller), {})

        # Un servicio MCP externo sin permiso tampoco se ejecuta sin preguntar: pausa igual; con su servidor permitido, se ejecuta.
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "server_of", return_value="ext_srv"), \
             unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value={"content": [{"type": "text", "text": "ok"}]}) as mock_ext:
            res, err, _ = zerochat.call_tool({"name": "ext_srv__ping", "arguments": {}}, self.ctx)
            self.assertIsNone(err)
            self.assertEqual((res.get("awaitingApproval"), res.get("serverId")), (True, "ext_srv"))
            mock_ext.assert_not_called()
            self.controller.apply_session_overlay({"servers": {"ext_srv": {"policy": zerochat.POLICY_ALLOW}}}, self.ctx)
            res, err, _ = zerochat.call_tool({"name": "ext_srv__ping", "arguments": {}}, self.ctx)
            self.assertEqual(res["content"][0]["text"], "ok")
            mock_ext.assert_called_once()

        saved_global, saved_project = zerochat.get_security_policy_data(cwd().key)
        self.assertEqual((saved_project, list(saved_global["tools"])), (None, ["db_tool"]))

        zerochat.RUN_SESSION = None
        zerochat.reset_session_authorizations()
        self.assertFalse(allow_all_of(self.controller))
        self.assertIsNone(tool_entry(self.controller, "custom_tool"))

    def test_maintenance_directory_with_root_rw_allows_unrestricted_run_while_other_stays_contained(self):
        maint_dir = self.base_dir / "mantenimiento"
        restricted_dir = self.base_dir / "contenido"
        maint_dir.mkdir()
        restricted_dir.mkdir()
        ctx_maint = zerochat.SecurityContext(maint_dir.resolve())
        ctx_restricted = zerochat.SecurityContext(restricted_dir.resolve())
        set_rules(self.controller, ["RWX:/**"], ctx_maint)

        self.addCleanup(setattr, zerochat, "RUN_SESSION", None)
        zerochat.RUN_SESSION = zerochat.RunSession(prompt="mantenimiento")
        use_project(self, maint_dir)
        zerochat.reset_session_authorizations()

        self.assertTrue(self.evaluate("write_file", {"path": "/etc/passwd"}, ctx_maint).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": "cat /etc/passwd > /tmp/out"}, ctx_maint).allowed)
        # El proyecto sin RW:/** sigue contenido en la misma ejecución
        paused = zerochat.call_tool({"name": "read_file", "arguments": {"path": "/etc/passwd"}}, ctx_restricted)[0]
        self.assertTrue(paused.get("awaitingApproval"))

    def test_rotating_the_daily_token_forgets_session_authorizations_and_challenges(self):
        set_tool(self.controller, "tool_x", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        set_tool(self.controller, "tool_y", zerochat.POLICY_ALLOW)
        self.controller.create_challenge("tool_z", {}, self.evaluate("tool_z"), context=self.ctx)
        today = zerochat.datetime.date.today().isoformat()
        with unittest.mock.patch.multiple(zerochat, SESSION_TOKEN="x" * 43, SESSION_TOKEN_DATE=today):
            # Mismo día: el token y la sesión siguen.
            self.assertEqual(zerochat.current_session_token(), "x" * 43)
            self.assertEqual(tool_entry(self.controller, "tool_x")["scope"], zerochat.SCOPE_SESSION)
            self.assertEqual(len(challenges(self.controller)), 1)
            # Día siguiente: nuevo token, y lo autorizado en la sesión anterior vuelve a pedirse.
            zerochat.SESSION_TOKEN_DATE = "2000-01-01"
            self.assertNotEqual(zerochat.current_session_token(), "x" * 43)
            self.assertIsNone(tool_entry(self.controller, "tool_x"))
            self.assertEqual(self.evaluate("tool_x").status, "ask")
            self.assertEqual(len(challenges(self.controller)), 0)
            self.assertEqual(tool_entry(self.controller, "tool_y")["policy"], zerochat.POLICY_ALLOW)

    def test_each_project_keeps_its_own_session_and_challenges(self):
        other = self.base_dir / "otro"
        other.mkdir()
        project_a = use_project(self, self.workspace)
        project_b = zerochat.SecurityContext(other.resolve())
        set_tool(self.controller, "custom_tool", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        set_patterns_session = self.controller.apply_session_overlay({"commandPatterns": {"session": ["make *"]}}, project_a)
        self.assertEqual(set_patterns_session["commandPatterns"]["session"], ["make *"])
        ch = self.controller.create_challenge("other_tool", {}, self.evaluate("other_tool"), context=project_a)

        # Cambiar de proyecto no borra nada; el otro proyecto empieza con su sesión vacía
        self.assertEqual(zerochat.resolve_project_directory(str(other), project_a)["cwd"], str(other.resolve()))
        self.assertIsNone(tool_entry(self.controller, "custom_tool", project_b))
        self.assertEqual(self.controller.export_state(project_b)["commandPatterns"]["session"], [])
        self.assertIsNone(self.controller.authorize_challenge(ch["id"], "allow_once", context=project_b))
        self.assertFalse(self.controller.revoke_challenge(ch["id"], context=project_b))

        # Al volver, el proyecto conserva su sesión y su reto; un cambio permanente sustituye la entrada de sesión en todos los proyectos
        self.assertEqual(tool_entry(self.controller, "custom_tool", project_a)["policy"], "allow")
        self.assertIn(ch["id"], challenges(self.controller, project_a))
        self.assertIsNotNone(self.controller.authorize_challenge(ch["id"], "allow_once", context=project_a))
        self.controller.apply_session_overlay({"tools": {"custom_tool": {"policy": "allow"}}}, project_b)
        set_tool(self.controller, "custom_tool", zerochat.POLICY_DENY)
        self.assertEqual(tool_entry(self.controller, "custom_tool", project_b)["policy"], "deny")

    def test_project_sessions_are_capped_releasing_the_least_recently_used_without_commands(self):
        projects = {}
        for name in "abcd":
            (self.base_dir / name).mkdir()
            projects[name] = zerochat.SecurityContext((self.base_dir / name).resolve())
        controller = zerochat.AccessController()
        running = set()
        self.addCleanup(setattr, zerochat, "JOBS", zerochat.JOBS)
        zerochat.JOBS = unittest.mock.Mock(running=lambda project: [project] if project in running else [])
        key = lambda name: projects[name].key
        with unittest.mock.patch.object(zerochat, "MAX_PROJECT_SESSIONS", 2):
            controller.apply_session_overlay({"tools": {"t": {"policy": "allow"}}}, projects["a"])
            controller.export_state(projects["b"])
            self.assertEqual(len(controller.sessions), 2, "N proyectos caben")
            # N+1: se olvida el usado hace más tiempo (a), salvo que tenga comandos en marcha: entonces b
            running.add(key("a"))
            controller.export_state(projects["c"])
            self.assertEqual(set(controller.sessions), {key("a"), key("c")})
            running.clear()
            controller.export_state(projects["d"])
            self.assertEqual(set(controller.sessions), {key("c"), key("d")})
            self.assertIsNone(tool_entry(controller, "t", projects["a"]), "Al volver, a empieza vacía")


class RpcValidationTest(unittest.TestCase):
    def test_el_metodo_y_el_nombre_de_herramienta_admiten_128_caracteres_y_no_129(self):
        validate = zerochat.ZeroChatServerHandler._validate_rpc
        for limit, request in (
            (zerochat.MAX_RPC_METHOD_LENGTH, lambda size: {"jsonrpc": "2.0", "id": 1, "method": "m" * size}),
            (zerochat.MAX_TOOL_NAME_LENGTH, lambda size: {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": "t" * size, "arguments": {}}}),
        ):
            with self.subTest(limit=limit, request=request(1)["method"]):
                self.assertIsNone(validate(request(limit)))
                self.assertIsNotNone(validate(request(limit + 1)))


if __name__ == "__main__":
    unittest.main()
