import os
import sqlite3
import unittest
import unittest.mock
from pathlib import Path

from backend import use_data_dir, zerochat


# Las pruebas preparan y leen el estado por el mismo contrato que la RPC (import_state/export_state).
def set_global(controller, policy):
    controller.import_state({"globalMcpPolicy": policy})


def global_policy(controller):
    return controller.export_state()["globalMcpPolicy"]


def set_rules(controller, rules, ctx=None):
    controller.import_state({"directoryRules": rules}, ctx)


def rules_of(controller, ctx=None):
    return controller.export_state(ctx)["directoryRules"]


def set_tool(controller, tool_id, policy, constraints=None, scope=zerochat.SCOPE_PERMANENT):
    patch = {"tools": {tool_id: {"policy": policy, "constraints": constraints}}}
    if scope == zerochat.SCOPE_SESSION:
        controller.apply_session_overlay(patch)
    else:
        controller.import_state(patch)


def set_server(controller, server_id, policy):
    controller.import_state({"servers": {server_id: {"policy": policy}}})


def revoke(controller, kind, item_id):
    controller.import_state({kind: {item_id: None}})


def tool_entry(controller, tool_id):
    return controller.export_state()["tools"].get(tool_id)


def server_entry(controller, server_id):
    return controller.export_state()["servers"].get(server_id)


def stored(kind):
    """Entradas permanentes guardadas en SQLite, sin la capa de sesión."""
    return (zerochat.get_security_policy_data() or {}).get(kind) or {}


def command_constraints(*patterns):
    return {"command": {"allowedPatterns": list(patterns)}}


class SecurityContextTest(unittest.TestCase):
    def test_resolve_path_inside_workspace_and_rejects_references_and_escapes(self):
        base_dir = use_data_dir(self)
        workspace = base_dir / "workspace"
        workspace.mkdir()
        ctx = zerochat.SecurityContext(workspace_dir=workspace)

        self.assertEqual(ctx.resolve_path("file.txt"), (workspace / "file.txt").resolve())
        self.assertTrue(ctx.is_inside_workspace("file.txt"))
        for unresolved in ("~/secret", "$HOME/secret", "${SECRET}/file", "path\0evil"):
            self.assertIsNone(ctx.resolve_path(unresolved), unresolved)
        self.assertFalse(ctx.is_inside_workspace("../outside.txt"))
        self.assertFalse(ctx.is_inside_workspace(str(base_dir / "outside.txt")))


class ControllerTestCase(unittest.TestCase):
    """Directorio de datos propio, un proyecto y un controlador nuevo por prueba."""

    def setUp(self):
        self.base_dir = use_data_dir(self)
        self.workspace = self.base_dir / "proj"
        self.workspace.mkdir()
        self.norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.ctx = zerochat.SecurityContext(workspace_dir=self.workspace)
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
        self.handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)

    def call_local(self, name, arguments, **extra):
        res, err, _ = self.handler._dispatch_local("tools/call", {"name": name, "arguments": arguments, **extra})
        self.assertIsNone(err)
        return res

    def authorize(self, challenge_id, decision, **extra):
        res, err, _ = self.handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": challenge_id, "decision": decision, **extra
        })
        return res, err

    def command_challenge(self, command):
        gate = self.call_local("run_command", {"command": command})
        self.assertTrue(gate.get("requiresAuthorization"), gate)
        return gate

    def status(self, command, ctx=None):
        cwd_ctx = ctx or zerochat.SecurityContext(workspace_dir=Path.cwd().resolve())
        return self.controller.evaluate_authorization("run_command", {"command": command}, cwd_ctx).status


class PolicyEvaluationTest(ControllerTestCase):
    def test_policy_precedence(self):
        dec = self.evaluate("run_command", {"command": "ls"})
        self.assertEqual((dec.status, dec.requires_approval), ("ask", True))

        set_global(self.controller, zerochat.GLOBAL_POLICY_ALLOW_ALL)
        dec = self.evaluate("run_command", {"command": "rm -rf /"})
        self.assertEqual((dec.status, dec.reason), ("allow", "mcp_global_allow_all"))

        # Una denegación concreta prevalece sobre allow_all
        set_tool(self.controller, "run_command", zerochat.POLICY_DENY)
        dec = self.evaluate("run_command", {"command": "echo 1"})
        self.assertEqual((dec.status, dec.reason), ("deny", "granular_deny_rule"))
        set_server(self.controller, "srv1", zerochat.POLICY_DENY)
        dec = self.evaluate("custom_tool", server_id="srv1")
        self.assertEqual((dec.status, dec.reason), ("deny", "server_deny_rule"))

    def test_directory_rules_evaluation(self):
        set_rules(self.controller, [f"R:{self.norm_ws}/docs/**", f"W:{self.norm_ws}/src/**"], self.ctx)
        self.assertTrue(self.evaluate("read_file", {"path": f"{self.norm_ws}/docs/readme.md"}).allowed)
        self.assertEqual(self.evaluate("write_file", {"path": f"{self.norm_ws}/docs/readme.md"}).status, "ask")
        self.assertTrue(self.evaluate("write_file", {"path": f"{self.norm_ws}/src/main.py"}).allowed)

    def test_directory_rules_real_path_symlinks_and_relative_escapes(self):
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

        # Ruta relativa con .. que sale del proyecto: pide confirmación
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        for escape_path in ("../outside.txt", "sub/../../outside.txt", f"{self.norm_ws}/../outside.txt"):
            for tool in ("read_file", "write_file"):
                self.assertEqual(self.evaluate(tool, {"path": escape_path}).status, "ask", escape_path)

    def test_default_rule_follows_the_project_and_is_never_stored(self):
        proj_a, proj_b = self.base_dir / "proj_a", self.base_dir / "proj_b"
        for proj in (proj_a, proj_b):
            proj.mkdir()
            (proj / "test.txt").write_text("hello", encoding="utf-8")
        ctx_a = zerochat.SecurityContext(workspace_dir=proj_a)
        ctx_b = zerochat.SecurityContext(workspace_dir=proj_b)
        file_a, file_b = str(proj_a / "test.txt"), str(proj_b / "test.txt")
        rule_a = f"RW:{zerochat.normalize_directory_path(str(proj_a.resolve()))}/**"

        self.assertTrue(self.evaluate("read_file", {"path": file_a}, ctx_a).allowed)
        self.assertTrue(self.evaluate("write_file", {"path": file_a}, ctx_a).allowed)
        self.assertEqual(self.evaluate("read_file", {"path": file_b}, ctx_a).status, "ask")

        # La regla por defecto se exporta aparte y no se guarda aunque llegue en un parche
        exported_a = self.controller.export_state(ctx_a)
        self.assertEqual((exported_a["directoryRules"], exported_a["defaultDirectoryRule"]), ([], rule_a))
        self.controller.import_state({**exported_a, "directoryRules": [rule_a]}, context=ctx_a)
        self.assertEqual(zerochat.get_security_policy_data().get("directoryRules"), [])

        # En el proyecto B rige su propia regla y A deja de estar autorizado
        self.assertTrue(self.evaluate("write_file", {"path": file_b}, ctx_b).allowed)
        self.assertEqual(self.evaluate("read_file", {"path": file_a}, ctx_b).status, "ask")

        # Desde B, la regla de A sí es una regla más y se guarda
        set_rules(self.controller, [rule_a, self.controller.get_default_directory_rule(ctx_b)], ctx_b)
        self.assertEqual(zerochat.get_security_policy_data().get("directoryRules"), [rule_a])

    def test_workspace_trust_allows_local_commands_and_paths_but_not_references_outside(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        self.assertTrue(self.evaluate("read_file", {"path": f"{self.norm_ws}/inside.txt"}).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": "ls -la | grep test"}).allowed)
        for path in ("/etc/passwd", "~/.ssh/id_rsa", "$HOME/.bashrc", "../outside.txt", "/workspace/../etc/passwd"):
            self.assertEqual(self.evaluate("read_file", {"path": path}).status, "ask", path)
        self.assertEqual(self.evaluate("run_command", {"command": "sudo apt update"}).status, "ask")

    def test_command_patterns_never_cover_chaining_pipes_or_redirection(self):
        set_tool(self.controller, "run_command", zerochat.POLICY_ALLOW, constraints=command_constraints("git *"))
        self.assertTrue(self.evaluate("run_command", {"command": "git status"}).allowed)
        for command in ("git status && ls", "git log | head", "git log > out.txt"):
            self.assertEqual(self.evaluate("run_command", {"command": command}).reason, "command_chaining_requires_approval", command)

    def test_leading_cd_must_be_covered_by_directory_rules(self):
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        set_tool(self.controller, "run_command", zerochat.POLICY_ALLOW, constraints=command_constraints("git *"))
        self.assertTrue(self.evaluate("run_command", {"command": f"cd {self.norm_ws} && git status"}).allowed)
        self.assertTrue(self.evaluate("run_command", {"command": f"cd {self.norm_ws} ; git status"}).allowed)
        self.assertEqual(self.evaluate("run_command", {"command": "cd /etc && git status"}).status, "ask")
        self.assertEqual(self.evaluate("run_command", {"command": "cd /etc; git status"}).status, "ask")
        # Solo el primer ';' tras el cd separa; los siguientes siguen siendo encadenamiento
        self.assertEqual(self.evaluate("run_command", {"command": f"cd {self.norm_ws}; git status; ls"}).status, "ask")

    def test_rule_offer_for_commands_and_directories(self):
        set_rules(self.controller, [f"R:{self.norm_ws}/**"], self.ctx)
        offers = {
            "./myui --port 8080": "./myui *",
            "cd /tmp && git status": "git status *",   # el cd no forma parte del patrón
            "ls -la": "ls *",                            # una opción no es un subcomando
        }
        for command, pattern in offers.items():
            offer = self.evaluate("run_command", {"command": command}).rule_offer
            self.assertEqual((offer["type"], offer["command"]), ("command", pattern), command)
            self.assertEqual(offer["constraints"]["command"]["allowedPatterns"], [pattern])

        offer = self.evaluate("write_file", {"path": f"{self.norm_ws}/src/app.py"}).rule_offer
        self.assertEqual((offer["type"], offer["access"], offer["directoryRule"]), ("directory", "W", f"W:{self.norm_ws}/src/**"))
        self.assertIsNone(self.evaluate("read_file", {"path": "~/.ssh/id_rsa"}).rule_offer)
        # Las herramientas externas no se autorizan por carpeta
        dec = self.evaluate("srv__write_file", {"path": "/tmp/x.txt"}, server_id="srv")
        self.assertEqual((dec.status, dec.rule_offer), ("ask", None))

    def test_evaluation_reads_permanent_state_once(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        with unittest.mock.patch("zerochat.get_security_policy_data", wraps=zerochat.get_security_policy_data) as reader:
            self.evaluate("run_command", {"command": "cd /tmp && ls"}, server_id="srv")
        self.assertEqual(reader.call_count, 1)


class PolicyStateTest(ControllerTestCase):
    def test_partial_patch_update_and_revocation(self):
        set_tool(self.controller, "t1", zerochat.POLICY_ALLOW)
        set_tool(self.controller, "t2", zerochat.POLICY_DENY)
        set_tool(self.controller, "t_sess", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        set_server(self.controller, "s1", zerochat.POLICY_ALLOW)
        set_rules(self.controller, ["R:/tmp/docs/**"], self.ctx)

        # Una clave ausente no cambia nada; null revoca permanentes y de sesión
        res = self.controller.import_state({"tools": {"t3": {"policy": "allow"}}}, self.ctx)
        self.assertEqual(set(res["tools"]), {"t1", "t2", "t3", "t_sess"})
        self.assertEqual((list(res["servers"]), res["directoryRules"]), (["s1"], ["R:/tmp/docs/**"]))
        res = self.controller.import_state({"tools": {"t1": None, "t_sess": None}}, self.ctx)
        self.assertEqual(set(res["tools"]), {"t2", "t3"})
        res = self.controller.import_state({"servers": {"s1": None, "s2": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(list(res["servers"]), ["s2"])

        # Las RPC aplican el mismo parche y devuelven el estado completo
        handler = zerochat.ZeroChatServerHandler
        rpc, err, _ = handler._dispatch_security("zerochat/security/update", {"tools": {"t4": {"policy": "allow"}}})
        self.assertIsNone(err)
        self.assertEqual(set(rpc["policies"]["tools"]), {"t2", "t3", "t4"})
        got, err, _ = handler._dispatch_security("zerochat/security/get", {})
        self.assertIsNone(err)
        self.assertEqual(got["policies"]["tools"].keys(), rpc["policies"]["tools"].keys())

    def test_add_directory_rules_appends_in_the_same_patch(self):
        set_rules(self.controller, [f"R:{self.norm_ws}/docs/**"], self.ctx)
        res = self.controller.import_state({"addDirectoryRules": [f"RW:{self.norm_ws}/.zerochat", f"R:{self.norm_ws}/docs/**"]}, self.ctx)
        self.assertEqual(res["directoryRules"], [f"R:{self.norm_ws}/docs/**", f"RW:{self.norm_ws}/.zerochat"])
        with self.assertRaises(ValueError):
            self.controller.import_state({"addDirectoryRules": ["INVALID"]}, self.ctx)

    def test_invalid_patch_changes_nothing(self):
        set_rules(self.controller, [f"RW:{self.norm_ws}/**"], self.ctx)
        initial = self.controller.export_state(self.ctx)
        for payload in ({"globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL, "directoryRules": ["INVALID_NO_PREFIX_RULE"]},
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

    def test_security_update_sets_granted_at_and_keeps_it_for_unchanged_grants(self):
        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_000.0):
            first = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
        self.assertEqual(first["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)
        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_100.0):
            same = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
            changed = self.controller.import_state({"tools": {"t_g": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(same["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)
        self.assertEqual(changed["tools"]["t_g"]["grantedAt"], 1_700_000_100_000)

    def test_two_controllers_share_state_through_sqlite(self):
        # En memoria solo hay sesión y retos pendientes: el estado permanente vive en SQLite
        self.assertEqual(set(self.controller.__dict__), {"_lock", "session_global_policy", "session_directory_rules",
                                                         "session_tools", "session_servers", "pending_challenges"})
        controller_b = zerochat.AccessController()
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        set_tool(self.controller, "tool_shared", zerochat.POLICY_ALLOW)
        set_server(self.controller, "srv_shared", zerochat.POLICY_ALLOW)
        self.assertEqual(global_policy(controller_b), zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        self.assertEqual(tool_entry(controller_b, "tool_shared")["policy"], zerochat.POLICY_ALLOW)
        self.assertEqual(server_entry(controller_b, "srv_shared")["policy"], zerochat.POLICY_ALLOW)
        revoke(controller_b, "tools", "tool_shared")
        self.assertIsNone(tool_entry(self.controller, "tool_shared"))

    def test_record_decision_keeps_session_in_memory_and_persists_permanent(self):
        self.controller.record_decision({"decision": "allow_session"}, {"toolId": "tool_x", "serverName": "srv_x"}, context=self.ctx)
        self.assertEqual(tool_entry(self.controller, "tool_x")["scope"], "session")
        self.assertNotIn("tool_x", stored("tools"))

        self.controller.record_decision({"decision": "allow_always", "directoryRule": f"R:{self.norm_ws}/extra/**"},
                                        {"toolId": "tool_y"}, context=self.ctx)
        self.assertIn("tool_y", stored("tools"))
        self.assertIn(f"R:{self.norm_ws}/extra/**", rules_of(self.controller, self.ctx))

        self.controller.clear_session()
        self.assertIsNone(tool_entry(self.controller, "tool_x"))
        self.assertIsNotNone(tool_entry(self.controller, "tool_y"))

    def test_allow_always_and_directory_rule_are_persisted_in_one_transaction(self):
        limit = zerochat.MAX_POLICY_ENTRIES
        self.controller.import_state({"tools": {f"fill_{i}": {"policy": "allow"} for i in range(limit - 1)}}, self.ctx)
        # Herramienta + regla = N+1 entradas: no se guarda ninguna de las dos
        with self.assertRaises(ValueError):
            self.controller.record_decision({"decision": "allow_always", "directoryRule": f"R:{self.norm_ws}/extra/**"},
                                            {"toolId": "tool_tx"}, context=self.ctx)
        self.assertIsNone(tool_entry(self.controller, "tool_tx"))
        self.assertEqual(rules_of(self.controller, self.ctx), [])
        # Solo la herramienta = N entradas: se guarda
        self.controller.record_decision({"decision": "allow_always"}, {"toolId": "tool_tx"}, context=self.ctx)
        self.assertEqual(tool_entry(self.controller, "tool_tx")["policy"], zerochat.POLICY_ALLOW)

    def test_storage_failure_on_update_is_reported_and_changes_nothing(self):
        initial = self.controller.export_state(self.ctx)
        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")):
            res, err, _ = zerochat.ZeroChatServerHandler._dispatch_security("zerochat/security/update", {
                "globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL, "tools": {"my_tool": {"policy": "allow"}}
            })
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32603)
        self.assertIn("database is locked", err["message"])
        self.assertEqual(self.controller.export_state(self.ctx), initial)

    def test_corrupt_stored_policies_fail_visibly_and_are_not_overwritten(self):
        handler = zerochat.ZeroChatServerHandler
        with zerochat.open_storage() as conn:
            conn.execute("INSERT INTO security_policies (id, data_json, updated_at) VALUES ('default', '{corrupt', 0);")
            conn.commit()
        for method, params in (("zerochat/security/get", {}), ("zerochat/security/update", {"globalMcpPolicy": "allow_all"})):
            res, err, _ = handler._dispatch_security(method, params)
            self.assertIsNone(res)
            self.assertEqual(err["code"], -32603)
            self.assertIn("corruptas", err["message"])
        with zerochat.open_storage() as conn:
            raw = conn.execute("SELECT data_json FROM security_policies WHERE id = 'default';").fetchone()["data_json"]
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
            ch_ok = self.controller.create_challenge("run_command", {"command": "echo ok"}, dec)
            ch_exp = self.controller.create_challenge("run_command", {"command": "echo expired"}, dec)
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec):
            res, err = self.authorize(ch_ok["id"], "allow_once")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec + 0.001):
            res, err = self.authorize(ch_exp["id"], "allow_always", constraints=command_constraints("echo *"))
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertNotIn(ch_exp["id"], self.controller.pending_challenges)
        self.assertIsNone(tool_entry(self.controller, "run_command"))

        # Un cambio de directorio entre la creación y la autorización invalida el reto
        ch_cwd = self.controller.create_challenge("run_command", {"command": "echo cwd"}, dec)
        other_dir = self.workspace / "subdir"
        other_dir.mkdir()
        self.addCleanup(os.chdir, Path.cwd())
        os.chdir(other_dir)
        res, err = self.authorize(ch_cwd["id"], "allow_once")
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertNotIn(ch_cwd["id"], self.controller.pending_challenges)

    def test_authorize_executes_challenge_by_stored_origin(self):
        # Un reto de /mcp/external con el nombre de una herramienta local se ejecuta en el host externo
        gate, err, _ = self.handler._dispatch_external("tools/call", {"name": "read_file", "arguments": {"path": "/etc/passwd"}})
        self.assertIsNone(err)
        self.assertEqual(self.controller.pending_challenges[gate["challengeId"]]["origin"], "external")
        result = {"content": [{"type": "text", "text": "external-output"}], "isError": False}
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value=result) as external:
            res, err = self.authorize(gate["challengeId"], "allow_once")
        self.assertIsNone(err)
        self.assertEqual(res["result"]["content"][0]["text"], "external-output")
        external.assert_called_once_with("read_file", {"path": "/etc/passwd"})

    def test_server_trust_covers_only_its_tools_and_never_local_ones(self):
        set_server(self.controller, "playwright", zerochat.POLICY_ALLOW)
        result = {"content": [{"type": "text", "text": "ok"}], "isError": False}
        with unittest.mock.patch.object(zerochat.GLOBAL_MCP_MANAGER, "call", return_value=result) as external:
            res, err, _ = self.handler._dispatch_external("tools/call", {"name": "playwright__x", "arguments": {}})
            self.assertIsNone(err)
            self.assertFalse(res.get("requiresAuthorization", False))
            res, err, _ = self.handler._dispatch_external("tools/call", {"name": "otro__y", "arguments": {}})
            self.assertEqual((res.get("requiresAuthorization"), res["serverId"]), (True, "otro"))
        external.assert_called_once_with("playwright__x", {})

        # allow_server_always sobre una herramienta local se rechaza y no añade servidores
        revoke(self.controller, "servers", "playwright")
        gate = self.command_challenge("echo local_test")
        self.assertEqual(gate.get("serverId"), "")
        res, err = self.authorize(gate["challengeId"], "allow_server_always", serverId="mcp-proxy")
        self.assertEqual((res, err["code"]), (None, -32002))
        self.assertEqual(stored("servers"), {})

    def test_invalid_directory_rule_fails_visibly_and_keeps_challenge(self):
        ch = self.controller.create_challenge("custom_tool", {}, self.evaluate("custom_tool"))
        res, err = self.authorize(ch["id"], "allow_always", directoryRule="INVALID_RULE")
        self.assertEqual((res, err["code"]), (None, -32602))
        self.assertIn(ch["id"], self.controller.pending_challenges)
        self.assertIsNone(tool_entry(self.controller, "custom_tool"))

    def test_storage_failure_on_authorize_is_reported_and_tool_not_executed(self):
        ch = self.controller.create_challenge("custom_tool", {}, self.evaluate("custom_tool"))
        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")), \
                unittest.mock.patch.object(zerochat.ZeroChatServerHandler, "_execute_tool") as execute:
            res, err = self.authorize(ch["id"], "allow_always")
        self.assertEqual((res, err["code"]), (None, -32603))
        self.assertIn("database is locked", err["message"])
        execute.assert_not_called()

    def test_job_key_is_not_a_challenge_argument_but_reaches_execution(self):
        gate = self.call_local("run_command", {"command": "echo job"}, _meta={"zerochatJobKey": "inv-1"})
        self.assertEqual(gate["arguments"], {"command": "echo job"})
        with unittest.mock.patch.object(zerochat.ZeroChatServerHandler, "_execute_tool", return_value=({"content": []}, None, "")) as execute:
            res, err = self.authorize(gate["challengeId"], "allow_once")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        execute.assert_called_once_with("local", "run_command", {"command": "echo job", "job_key": "inv-1"})


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
        res = self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": command_constraints(
            "git status *", "git  status  *", "git status", "git diff *", "git diff --stat")}}}, self.ctx)
        self.assertEqual(res["tools"]["run_command"]["constraints"]["command"]["allowedPatterns"], ["git status *", "git diff *"])

        def store(command):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {"command": command}}}}, self.ctx)

        for bad in ([], ["git; rm"], ["git $(x)"], [""], ["*"], ["g* log"], ["git **"], ["git 'x'"], [3]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store({"allowedPatterns": bad})
        with self.assertRaises(ValueError):
            store({"allowedPatterns": [], "projectPatterns": {"relativo": ["git"]}})
        # Guardar run_command sin patrones autorizaría cualquier comando; en la sesión sí se admite
        with self.assertRaisesRegex(ValueError, "allow_always_requires_constraints"):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow"}}}, self.ctx)
        self.controller.apply_session_overlay({"tools": {"run_command": {"policy": "allow"}}})

        # El tope cuenta los patrones globales y los de todos los proyectos: N se acepta y N+1 no
        limit = zerochat.MAX_COMMAND_PATTERNS
        half = limit // 2
        store({"allowedPatterns": [f"g{i}" for i in range(half)], "projectPatterns": {"/proj": [f"p{i}" for i in range(limit - half)]}})
        with self.assertRaisesRegex(ValueError, "máximo"):
            store({"allowedPatterns": [f"g{i}" for i in range(half)], "projectPatterns": {"/proj": [f"p{i}" for i in range(limit - half + 1)]}})

    def test_stored_empty_pattern_list_never_allows_any_command(self):
        zerochat.update_security_policy_data(lambda current: {**(current or {}), "tools": {
            "run_command": {"policy": "allow", "scope": "permanent", "constraints": {"command": {"allowedPatterns": []}}}
        }})
        dec = self.evaluate("run_command", {"command": "rm -rf build"})
        self.assertEqual((dec.status, dec.reason), ("ask", "command_outside_allowed_patterns"))

    def test_command_grants_need_a_pattern_that_covers_the_challenge(self):
        gate = self.command_challenge("echo hola mundo")
        cid = gate["challengeId"]
        self.assertEqual(gate["ruleOffer"]["command"], "echo hola *")
        # Si el * no cubriría los argumentos (fuera del proyecto), se ofrece el comando exacto
        self.assertEqual(self.command_challenge("cat /etc/hosts")["ruleOffer"]["command"], "cat /etc/hosts")
        rejected = (
            ("allow_always", {}, "allow_always_requires_constraints"),
            ("allow_project", {}, "allow_project_requires_command_pattern"),
            ("allow_always", {"constraints": command_constraints("echo adios *")}, None),
        )
        for decision, extra, message in rejected:
            res, err = self.authorize(cid, decision, **extra)
            self.assertEqual((res, err["code"]), (None, -32602), decision)
            if message:
                self.assertEqual(err["message"], message)
            self.assertIn(cid, self.controller.pending_challenges)

        res, err = self.authorize(cid, "allow_always", constraints=command_constraints("echo *"))
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        self.assertEqual(stored("tools")["run_command"]["constraints"]["command"]["allowedPatterns"], ["echo *"])
        self.assertEqual(self.status("echo otra cosa"), "allow")
        self.assertEqual(self.status("rm -rf /"), "ask")

    def test_command_pattern_scopes_session_project_and_global(self):
        other_project = zerochat.SecurityContext(workspace_dir=self.base_dir.resolve())
        project = zerochat.normalize_directory_path(str(Path.cwd().resolve()))

        # Sesión: solo ese patrón, en memoria y sin guardarse
        res, err = self.authorize(self.command_challenge("echo uno")["challengeId"], "allow_session", constraints=command_constraints("echo uno *"))
        self.assertIsNone(err)
        self.assertEqual((self.status("echo uno dos"), self.status("echo otro")), ("allow", "ask"))
        self.assertNotIn("run_command", stored("tools"))

        # Proyecto: guardado ligado al proyecto actual; en otro proyecto vuelve a preguntar
        res, err = self.authorize(self.command_challenge("printf proyecto")["challengeId"], "allow_project", constraints=command_constraints("printf *"))
        self.assertIsNone(err)
        command = stored("tools")["run_command"]["constraints"]["command"]
        self.assertEqual((command["allowedPatterns"], command["projectPatterns"]), ([], {project: ["printf *"]}))
        self.assertEqual((self.status("printf x"), self.status("printf x", other_project)), ("allow", "ask"))
        # La escritura permanente no retira los patrones de sesión: se suman
        self.assertEqual(self.status("echo uno dos"), "allow")

        # Global: vale en cualquier proyecto
        res, err = self.authorize(self.command_challenge("true global")["challengeId"], "allow_always", constraints=command_constraints("true *"))
        self.assertIsNone(err)
        self.assertEqual(self.status("true x", other_project), "allow")
        exported = self.controller.export_state()["tools"]["run_command"]["constraints"]["command"]
        self.assertEqual((exported["sessionPatterns"], exported["allowedPatterns"]), (["echo uno *"], ["true *"]))

        # Al acabar la sesión solo quedan los permanentes
        self.controller.clear_session()
        self.assertEqual([self.status(c) for c in ("echo uno dos", "printf x", "true x")], ["ask", "allow", "allow"])

    def test_exported_session_patterns_survive_a_session_overlay(self):
        self.authorize(self.command_challenge("echo capa")["challengeId"], "allow_session", constraints=command_constraints("echo capa *"))
        snapshot = self.controller.export_state()
        self.controller.clear_session()
        self.controller.apply_session_overlay(snapshot)
        self.assertEqual(self.status("echo capa x"), "allow")


class SessionLifecycleTest(HandlerTestCase):
    def test_reset_session_credentials_applies_the_run_overlay_without_storing_it(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_ASK)
        set_tool(self.controller, "db_tool", zerochat.POLICY_DENY)
        self.addCleanup(setattr, zerochat, "RUN_SESSION", None)
        zerochat.RUN_SESSION = zerochat.RunSession(prompt="test", allow_dangerous_tools=True, tool_security={
            "globalMcpPolicy": "allow_all", "tools": {"custom_tool": {"policy": "allow"}}, "directoryRules": ["RW:/test/**"]
        })
        zerochat.reset_session_credentials()

        for tool in ("write_file", "edit_file", "run_command", "custom_tool"):
            self.assertEqual(tool_entry(self.controller, tool)["policy"], "allow", tool)
        self.assertEqual(global_policy(self.controller), "allow_all")
        self.assertTrue(self.evaluate("custom_tool").allowed)
        saved = zerochat.get_security_policy_data()
        self.assertEqual((saved["globalMcpPolicy"], list(saved["tools"])), ("ask", ["db_tool"]))

        zerochat.RUN_SESSION = None
        zerochat.reset_session_credentials()
        self.assertEqual(global_policy(self.controller), "ask")
        self.assertIsNone(tool_entry(self.controller, "custom_tool"))

    def test_changing_project_clears_session_authorizations_and_challenges(self):
        self.addCleanup(os.chdir, Path.cwd())
        other = self.base_dir / "otro"
        other.mkdir()
        os.chdir(self.workspace)
        set_tool(self.controller, "custom_tool", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        self.controller.create_challenge("other_tool", {}, self.evaluate("other_tool"))

        # Volver a elegir el mismo proyecto no borra nada
        zerochat.set_project_directory(str(self.workspace))
        self.assertIsNotNone(tool_entry(self.controller, "custom_tool"))
        self.assertEqual(len(self.controller.pending_challenges), 1)

        zerochat.set_project_directory(str(other))
        self.assertIsNone(tool_entry(self.controller, "custom_tool"))
        self.assertEqual(self.controller.pending_challenges, {})


if __name__ == "__main__":
    unittest.main()
