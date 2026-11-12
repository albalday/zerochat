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


class SecurityContextTest(unittest.TestCase):
    def setUp(self):
        self.base_dir = use_data_dir(self)
        self.workspace = self.base_dir / "workspace"
        self.workspace.mkdir()
        (self.workspace / "file.txt").write_text("ok", encoding="utf-8")
        self.ctx = zerochat.SecurityContext(workspace_dir=self.workspace)

    def test_context_fields_and_defaults(self):
        ctx_default = zerochat.SecurityContext()
        self.assertIsNotNone(ctx_default.workspace_dir)
        self.assertEqual(self.ctx.workspace_dir, self.workspace)

    def test_resolve_path_inside_workspace(self):
        res = self.ctx.resolve_path("file.txt")
        self.assertIsNotNone(res)
        self.assertEqual(res, (self.workspace / "file.txt").resolve())
        self.assertTrue(self.ctx.is_inside_workspace("file.txt"))

    def test_resolve_path_rejects_unresolved_references_and_escapes(self):
        self.assertIsNone(self.ctx.resolve_path("~/secret"))
        self.assertIsNone(self.ctx.resolve_path("$HOME/secret"))
        self.assertIsNone(self.ctx.resolve_path("${SECRET}/file"))
        self.assertIsNone(self.ctx.resolve_path("path\0evil"))

        # Outside workspace detection
        outside_file = self.base_dir / "outside.txt"
        outside_file.write_text("secret", encoding="utf-8")
        self.assertFalse(self.ctx.is_inside_workspace("../outside.txt"))
        self.assertFalse(self.ctx.is_inside_workspace(str(outside_file)))


class AccessControllerPolicyTest(unittest.TestCase):
    def setUp(self):
        self.base_dir = use_data_dir(self)
        self.workspace = self.base_dir / "proj"
        self.workspace.mkdir()
        self.ctx = zerochat.SecurityContext(workspace_dir=self.workspace)
        self.controller = zerochat.AccessController()

    def test_default_policy_is_ask(self):
        self.assertEqual(global_policy(self.controller), zerochat.GLOBAL_POLICY_ASK)
        dec = self.controller.evaluate_authorization("run_command", {"command": "ls"}, self.ctx)
        self.assertFalse(dec.allowed)
        self.assertTrue(dec.requires_approval)
        self.assertEqual(dec.status, "ask")

    def test_global_allow_all(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_ALLOW_ALL)
        dec = self.controller.evaluate_authorization("run_command", {"command": "rm -rf /"}, self.ctx)
        self.assertTrue(dec.allowed)
        self.assertEqual(dec.status, "allow")
        self.assertEqual(dec.reason, "mcp_global_allow_all")

    def test_blacklist_takes_precedence_over_allow_all(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_ALLOW_ALL)
        set_tool(self.controller, "run_command", zerochat.POLICY_DENY)
        dec = self.controller.evaluate_authorization("run_command", {"command": "echo 1"}, self.ctx)
        self.assertFalse(dec.allowed)
        self.assertEqual(dec.status, "deny")
        self.assertEqual(dec.reason, "granular_deny_rule")

    def test_server_blacklist(self):
        set_server(self.controller, "srv1", zerochat.POLICY_DENY)
        dec = self.controller.evaluate_authorization("custom_tool", {}, self.ctx, server_id="srv1")
        self.assertFalse(dec.allowed)
        self.assertEqual(dec.status, "deny")
        self.assertEqual(dec.reason, "server_deny_rule")

    def test_directory_rules_evaluation(self):
        # Default directory rule is RW for workspace
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"R:{norm_ws}/docs/**", f"W:{norm_ws}/src/**"], self.ctx)

        read_docs = self.controller.evaluate_authorization("read_file", {"path": f"{norm_ws}/docs/readme.md"}, self.ctx)
        self.assertTrue(read_docs.allowed)

        write_docs = self.controller.evaluate_authorization("write_file", {"path": f"{norm_ws}/docs/readme.md"}, self.ctx)
        self.assertFalse(write_docs.allowed)
        self.assertEqual(write_docs.status, "ask")

        write_src = self.controller.evaluate_authorization("write_file", {"path": f"{norm_ws}/src/main.py"}, self.ctx)
        self.assertTrue(write_src.allowed)

    def test_command_constraints_prefixes_and_chaining(self):
        set_tool(self.controller, "run_command", zerochat.POLICY_ALLOW, constraints={
            "command": {
                "allowedPrefixes": ["git *", "npm *"],
                "allowChaining": False,
                "allowPipes": False,
                "deniedPatterns": ["rm -rf"]
            }
        })

        # Allowed command
        git_status = self.controller.evaluate_authorization("run_command", {"command": "git status"}, self.ctx)
        self.assertTrue(git_status.allowed)

        # Chained command requires approval
        chained = self.controller.evaluate_authorization("run_command", {"command": "git status && ls"}, self.ctx)
        self.assertFalse(chained.allowed)
        self.assertEqual(chained.status, "ask")

        # Denied pattern is denied
        blocked = self.controller.evaluate_authorization("run_command", {"command": "git rm -rf ."}, self.ctx)
        self.assertFalse(blocked.allowed)
        self.assertEqual(blocked.status, "deny")

    def test_workspace_trust_allows_local_commands_and_workspace_paths(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))

        # Inside workspace path read allowed
        read_local = self.controller.evaluate_authorization("read_file", {"path": f"{norm_ws}/inside.txt"}, self.ctx)
        self.assertTrue(read_local.allowed)

        # Outside workspace path asks
        read_outside = self.controller.evaluate_authorization("read_file", {"path": "/etc/passwd"}, self.ctx)
        self.assertFalse(read_outside.allowed)
        self.assertEqual(read_outside.status, "ask")

        # Local command without global tools
        cmd_local = self.controller.evaluate_authorization("run_command", {"command": "ls -la | grep test"}, self.ctx)
        self.assertTrue(cmd_local.allowed)

        # Sudo or outside access asks
        cmd_sudo = self.controller.evaluate_authorization("run_command", {"command": "sudo apt update"}, self.ctx)
        self.assertFalse(cmd_sudo.allowed)
        self.assertEqual(cmd_sudo.status, "ask")

    def test_record_decision_updates_policies_and_rules(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))

        # allow_session records in session_tools and appears in export_state with scope='session'
        self.controller.record_decision(
            {"decision": "allow_session"},
            {"toolId": "tool_x", "serverName": "srv_x"},
            context=self.ctx
        )
        self.assertIsNotNone(self.controller.session_tools.get("tool_x"))
        self.assertIsNone(stored("tools").get("tool_x"))
        exported = self.controller.export_state(self.ctx)
        self.assertEqual(exported["tools"]["tool_x"]["scope"], "session")

        # allow_always records in tools
        self.controller.record_decision(
            {"decision": "allow_always", "directoryRule": f"R:{norm_ws}/extra/**"},
            {"toolId": "tool_y"},
            context=self.ctx
        )
        self.assertIsNotNone(stored("tools").get("tool_y"))
        self.assertIn(f"R:{norm_ws}/extra/**", rules_of(self.controller, self.ctx))

        # Clear session clears session_tools but preserves permanent
        self.controller.clear_session()
        self.assertIsNone(self.controller.session_tools.get("tool_x"))
        self.assertIsNotNone(stored("tools").get("tool_y"))

    def test_persistence_in_sqlite(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        state = {
            "globalMcpPolicy": "workspace_trust",
            "directoryRules": [f"R:{norm_ws}/docs/**", f"W:{norm_ws}/output/**"],
            "tools": {"tool_saved": {"policy": "allow", "serverName": "srv"}},
            "servers": {"srv_saved": {"policy": "deny"}}
        }
        updated = zerochat.update_security_policy_data(lambda current: {**(current or {}), **state})
        self.assertEqual(updated["globalMcpPolicy"], "workspace_trust")

        loaded = zerochat.get_security_policy_data()
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["globalMcpPolicy"], "workspace_trust")
        self.assertEqual(loaded["tools"]["tool_saved"]["policy"], "allow")
        self.assertEqual(loaded["servers"]["srv_saved"]["policy"], "deny")

    def test_rpc_dispatch_security_get_and_update(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        handler = zerochat.ZeroChatServerHandler

        # 1. Update policies via RPC
        update_params = {
            "globalMcpPolicy": "workspace_trust",
            "directoryRules": [f"R:{norm_ws}/custom/**"],
            "tools": {"tool_rpc": {"policy": "allow", "serverName": "srv_rpc"}},
            "servers": {"srv_rpc": {"policy": "allow"}}
        }
        res, err, info = handler._dispatch_security("zerochat/security/update", update_params)
        self.assertIsNone(err)
        self.assertIsNotNone(res)
        self.assertEqual(res["policies"]["globalMcpPolicy"], "workspace_trust")
        self.assertIn(f"R:{norm_ws}/custom/**", res["policies"]["directoryRules"])
        self.assertEqual(res["policies"]["tools"]["tool_rpc"]["policy"], "allow")

        # 2. Get policies via RPC
        res_get, err_get, info_get = handler._dispatch_security("zerochat/security/get", {})
        self.assertIsNone(err_get)
        self.assertIsNotNone(res_get)
        self.assertEqual(res_get["policies"]["globalMcpPolicy"], "workspace_trust")
        self.assertEqual(res_get["policies"]["servers"]["srv_rpc"]["policy"], "allow")

    def test_challenge_creation_and_authorize_rpc(self):
        handler = zerochat.ZeroChatServerHandler
        dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("run_command", {"command": "echo test"}, self.ctx)
        ch = zerochat.ACCESS_CONTROLLER.create_challenge("run_command", {"command": "echo test"}, dec)
        self.assertIsNotNone(ch["id"])

        # zerochat/security/authorize autoriza, consume y ejecuta el reto en una sola operación
        res, err, info = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": ch["id"],
            "decision": "allow_once"
        })
        self.assertIsNone(err)
        self.assertEqual(res["authorized"], True)
        self.assertIn("test", res["result"]["content"][0]["text"])

        # El reto ya quedó consumido y no puede reutilizarse
        self.assertNotIn(ch["id"], zerochat.ACCESS_CONTROLLER.pending_challenges)
        res_again, err_again, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": ch["id"],
            "decision": "allow_once"
        })
        self.assertIsNone(res_again)
        self.assertEqual(err_again["code"], -32002)

    def test_tools_call_ignores_challenge_id_and_challenge_is_single_use(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)
        set_rules(zerochat.ACCESS_CONTROLLER, [], self.ctx)

        # Probe C1: crear un reto para get_diagnostics fuera del proyecto y autorizarlo con allow_session
        gate, err, _ = handler._dispatch_local("tools/call", {
            "name": "get_diagnostics",
            "arguments": {"path": str(self.base_dir)}
        })
        self.assertIsNone(err)
        self.assertTrue(gate.get("requiresAuthorization"))
        cid = gate["challengeId"]

        auth_res, auth_err, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid,
            "decision": "allow_session"
        })
        self.assertIsNone(auth_err)
        self.assertTrue(auth_res["authorized"])

        # El reto se consumió incluso con allow_session: una segunda autorización falla
        auth_twice, err_twice, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid,
            "decision": "allow_session"
        })
        self.assertIsNone(auth_twice)
        self.assertEqual(err_twice["code"], -32002)

        # Enviar challengeId o _meta.challengeId en tools/call para otra herramienta (write_file)
        # no salta la evaluación ni escribe el fichero: vuelve a emitir un reto nuevo
        outside_target = self.base_dir / "pwned_c1.txt"
        call_res, call_err, _ = handler._dispatch_local("tools/call", {
            "name": "write_file",
            "arguments": {"path": str(outside_target), "content": "exploit"},
            "challengeId": cid,
            "_meta": {"challengeId": cid}
        })
        self.assertIsNone(call_err)
        self.assertTrue(call_res.get("requiresAuthorization"))
        self.assertNotEqual(call_res["challengeId"], cid)
        self.assertFalse(outside_target.exists())

    def test_challenge_ttl_exact_boundary_and_cwd_change(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        base_sec = 1_700_000_000.0
        ttl_sec = zerochat.CHALLENGE_TTL_MS / 1000.0

        # Borde exacto N (600_000 ms): se acepta
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec):
            dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("run_command", {"command": "echo ok_boundary"}, self.ctx)
            ch_ok = zerochat.ACCESS_CONTROLLER.create_challenge("run_command", {"command": "echo ok_boundary"}, dec)
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec):
            res_ok, err_ok, _ = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": ch_ok["id"],
                "decision": "allow_once"
            })
        self.assertIsNone(err_ok)
        self.assertTrue(res_ok["authorized"])

        # Borde exacto N+1 (600_001 ms): se rechaza y se elimina
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec):
            ch_exp = zerochat.ACCESS_CONTROLLER.create_challenge("run_command", {"command": "echo expired"}, dec)
        with unittest.mock.patch.object(zerochat.time, "time", return_value=base_sec + ttl_sec + 0.001):
            res_exp, err_exp, _ = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": ch_exp["id"],
                "decision": "allow_always",
                "constraints": {"command": {"allowedPrefixes": ["echo"]}}
            })
        self.assertIsNone(res_exp)
        self.assertEqual(err_exp["code"], -32002)
        self.assertNotIn(ch_exp["id"], zerochat.ACCESS_CONTROLLER.pending_challenges)
        self.assertIsNone(tool_entry(zerochat.ACCESS_CONTROLLER, "run_command"))

        # Cambio de directorio entre creación y autorización: se rechaza
        ch_cwd = zerochat.ACCESS_CONTROLLER.create_challenge("run_command", {"command": "echo cwd"}, dec)
        other_dir = self.workspace / "subdir_cwd"
        other_dir.mkdir(exist_ok=True)
        orig_cwd = Path.cwd()
        try:
            os.chdir(other_dir)
            res_cwd, err_cwd, _ = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": ch_cwd["id"],
                "decision": "allow_once"
            })
        finally:
            os.chdir(orig_cwd)
        self.assertIsNone(res_cwd)
        self.assertEqual(err_cwd["code"], -32002)
        self.assertNotIn(ch_cwd["id"], zerochat.ACCESS_CONTROLLER.pending_challenges)

    def test_authorize_executes_challenge_by_stored_origin(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)

        # Un reto emitido en /mcp/external con un nombre que coincide con una herramienta local
        # ("read_file") debe ejecutarse en GLOBAL_MCP_MANAGER.call y nunca en LOCAL_TOOL_HANDLERS.
        gate_res, gate_err, _ = handler._dispatch_external("tools/call", {
            "name": "read_file",
            "arguments": {"path": "/etc/passwd"}
        })
        self.assertIsNone(gate_err)
        self.assertTrue(gate_res.get("requiresAuthorization"))
        challenge_id = gate_res["challengeId"]
        self.assertEqual(zerochat.ACCESS_CONTROLLER.pending_challenges[challenge_id]["origin"], "external")

        called_external = []
        orig_call = zerochat.GLOBAL_MCP_MANAGER.call

        def fake_external_call(name, args):
            called_external.append((name, args))
            return {"content": [{"type": "text", "text": "external-output"}], "isError": False}

        zerochat.GLOBAL_MCP_MANAGER.call = fake_external_call
        try:
            res, err, tool_err = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": challenge_id,
                "decision": "allow_once"
            })
        finally:
            zerochat.GLOBAL_MCP_MANAGER.call = orig_call

        self.assertIsNone(err)
        self.assertEqual(tool_err, "")
        self.assertTrue(res["authorized"])
        self.assertEqual(res["result"]["content"][0]["text"], "external-output")
        self.assertEqual(called_external, [("read_file", {"path": "/etc/passwd"})])

    def test_external_server_identity_and_local_rejects_server_trust(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)

        # Probe C2a: confiar en el servidor "playwright" autoriza playwright__x pero NO otro__y
        set_server(zerochat.ACCESS_CONTROLLER, "playwright", zerochat.POLICY_ALLOW)
        called_external = []
        orig_call = zerochat.GLOBAL_MCP_MANAGER.call

        def fake_external_call(name, args):
            called_external.append(name)
            return {"content": [{"type": "text", "text": f"ran:{name}"}], "isError": False}

        zerochat.GLOBAL_MCP_MANAGER.call = fake_external_call
        try:
            res_pw, err_pw, _ = handler._dispatch_external("tools/call", {
                "name": "playwright__x",
                "arguments": {}
            })
            self.assertIsNone(err_pw)
            self.assertFalse(res_pw.get("requiresAuthorization", False))
            self.assertEqual(called_external, ["playwright__x"])

            res_other, err_other, _ = handler._dispatch_external("tools/call", {
                "name": "otro__y",
                "arguments": {}
            })
            self.assertIsNone(err_other)
            self.assertTrue(res_other.get("requiresAuthorization"))
            self.assertEqual(res_other["serverId"], "otro")
        finally:
            zerochat.GLOBAL_MCP_MANAGER.call = orig_call

        # Probe C2b: allow_server_always sobre una herramienta local se rechaza y no añade servidores
        revoke(zerochat.ACCESS_CONTROLLER, "servers", "playwright")
        local_gate, local_err, _ = handler._dispatch_local("tools/call", {
            "name": "run_command",
            "arguments": {"command": "echo local_test"}
        })
        self.assertIsNone(local_err)
        self.assertTrue(local_gate.get("requiresAuthorization"))
        self.assertEqual(local_gate.get("serverId"), "")

        auth_res, auth_err, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": local_gate["challengeId"],
            "decision": "allow_server_always",
            "serverId": "mcp-proxy"
        })
        self.assertIsNone(auth_res)
        self.assertEqual(auth_err["code"], -32002)
        self.assertEqual(stored("servers"), {})

    def test_probe_c3_run_command_allow_always_requires_constraints(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)

        # 1. Ejecución de run_command emite un reto
        gate_res, gate_err, _ = handler._dispatch_local("tools/call", {
            "name": "run_command",
            "arguments": {"command": "ls"}
        })
        self.assertIsNone(gate_err)
        self.assertTrue(gate_res.get("requiresAuthorization"))
        cid = gate_res["challengeId"]

        # 2. allow_always sin constraints se rechaza con -32602 y el reto sigue pendiente
        res_fail, err_fail, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid,
            "decision": "allow_always"
        })
        self.assertIsNone(res_fail)
        self.assertEqual(err_fail["code"], -32602)
        self.assertEqual(err_fail["message"], "allow_always_requires_constraints")
        self.assertIn(cid, zerochat.ACCESS_CONTROLLER.pending_challenges)

        # 3. Con constraints de comando acotadas ("ls"), se autoriza y consume
        res_ok, err_ok, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid,
            "decision": "allow_always",
            "constraints": {"command": {"allowedPrefixes": ["ls *"]}}
        })
        self.assertIsNone(err_ok)
        self.assertTrue(res_ok["authorized"])
        self.assertNotIn(cid, zerochat.ACCESS_CONTROLLER.pending_challenges)

        # 4. Siguiente llamada con ls: permitida automáticamente
        call_ls, err_ls, _ = handler._dispatch_local("tools/call", {
            "name": "run_command",
            "arguments": {"command": "ls -la"}
        })
        self.assertIsNone(err_ls)
        self.assertFalse(call_ls.get("requiresAuthorization", False))

        # 5. Siguiente llamada con rm -rf /: pide confirmación (no se permite a ciegas)
        call_rm, err_rm, _ = handler._dispatch_local("tools/call", {
            "name": "run_command",
            "arguments": {"command": "rm -rf /"}
        })
        self.assertIsNone(err_rm)
        self.assertTrue(call_rm.get("requiresAuthorization"))

    def test_reset_session_credentials_with_run_session(self):
        # 1. Poblar SQLite con estado permanente previo
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)
        set_tool(zerochat.ACCESS_CONTROLLER, "db_tool", zerochat.POLICY_DENY)
        set_rules(zerochat.ACCESS_CONTROLLER, [f"R:{self.workspace}/**"], self.ctx)

        try:
            # 2. Configurar una ejecución con capa de políticas en memoria
            zerochat.RUN_SESSION = zerochat.RunSession(
                prompt="test",
                allow_dangerous_tools=True,
                tool_security={
                    "globalMcpPolicy": "allow_all",
                    "tools": {"custom_tool": {"policy": "allow"}},
                    "directoryRules": ["RW:/test/**"]
                }
            )
            zerochat.reset_session_credentials()

            for dt in ("write_file", "edit_file", "run_command"):
                pol = tool_entry(zerochat.ACCESS_CONTROLLER, dt)
                self.assertIsNotNone(pol)
                self.assertEqual(pol["policy"], "allow")
            custom_pol = tool_entry(zerochat.ACCESS_CONTROLLER, "custom_tool")
            self.assertIsNotNone(custom_pol)
            self.assertEqual(custom_pol["policy"], "allow")
            self.assertEqual(global_policy(zerochat.ACCESS_CONTROLLER), "allow_all")

            # 3. La capa sobrevive a la primera evaluación de autorización
            dec_custom = zerochat.ACCESS_CONTROLLER.evaluate_authorization("custom_tool", {}, self.ctx)
            self.assertTrue(dec_custom.allowed)

            # 4. No aparece en SQLite (no se persiste la capa de sesión)
            saved = zerochat.get_security_policy_data()
            self.assertIsNotNone(saved)
            self.assertEqual(saved["globalMcpPolicy"], "ask", "La BD debe conservar la política permanente 'ask'")
            self.assertIn("db_tool", saved["tools"])
            self.assertNotIn("custom_tool", saved["tools"], "La herramienta de sesión no debe persistirse en BD")
        finally:
            zerochat.RUN_SESSION = None
            zerochat.reset_session_credentials()

        # 5. Tras limpiar sesión, la capa desaparece y se recupera la política guardada
        self.assertEqual(global_policy(zerochat.ACCESS_CONTROLLER), "ask")
        self.assertIsNone(tool_entry(zerochat.ACCESS_CONTROLLER, "custom_tool"))



    def test_get_rule_offer_commands_and_directories(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"R:{norm_ws}/**"], self.ctx)

        # Command offer keeps executable path / prefix
        dec_cmd = self.controller.evaluate_authorization("run_command", {"command": "./myui --port 8080"}, self.ctx)
        self.assertIsNotNone(dec_cmd.rule_offer)
        self.assertEqual(dec_cmd.rule_offer["type"], "command")
        self.assertEqual(dec_cmd.rule_offer["command"], "./myui *")
        self.assertEqual(dec_cmd.rule_offer["constraints"]["command"]["allowedPrefixes"], ["./myui *"])

        # Command with cd prefix
        dec_cd = self.controller.evaluate_authorization("run_command", {"command": "cd /tmp && git status"}, self.ctx)
        self.assertIsNotNone(dec_cd.rule_offer)
        self.assertEqual(dec_cd.rule_offer["command"], "git status *")
        self.assertEqual(dec_cd.rule_offer["constraints"]["command"]["allowedPrefixes"], ["git status *"])

        # Una opción no es un subcomando: se ofrece solo el ejecutable
        dec_flag = self.controller.evaluate_authorization("run_command", {"command": "ls -la"}, self.ctx)
        self.assertEqual(dec_flag.rule_offer["command"], "ls *")

        # Directory offer
        dec_file = self.controller.evaluate_authorization("write_file", {"path": f"{norm_ws}/src/app.py"}, self.ctx)
        self.assertIsNotNone(dec_file.rule_offer)
        self.assertEqual(dec_file.rule_offer["type"], "directory")
        self.assertEqual(dec_file.rule_offer["access"], "W")
        self.assertEqual(dec_file.rule_offer["directoryRule"], f"W:{norm_ws}/src/**")

        # Unresolved reference returns no directory rule offer
        dec_unresolved = self.controller.evaluate_authorization("read_file", {"path": "~/.ssh/id_rsa"}, self.ctx)
        self.assertIsNone(dec_unresolved.rule_offer)


    def test_cd_command_and_directory_rules(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"R:{norm_ws}/**", f"W:{norm_ws}/**"], self.ctx)
        set_tool(self.controller, "run_command", zerochat.POLICY_ALLOW, constraints={
            "command": {"allowedPrefixes": ["git *"], "allowChaining": False, "allowPipes": False}
        })

        # cd inside workspace with allowed git command
        dec_cd_ok = self.controller.evaluate_authorization("run_command", {"command": f"cd {norm_ws} && git status"}, self.ctx)
        self.assertTrue(dec_cd_ok.allowed)

        # cd outside directory rules asks
        dec_cd_out = self.controller.evaluate_authorization("run_command", {"command": "cd /etc && git status"}, self.ctx)
        self.assertFalse(dec_cd_out.allowed)
        self.assertEqual(dec_cd_out.status, "ask")

    def test_unresolved_references_ask_in_workspace_trust(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"RW:{norm_ws}/**"], self.ctx)

        for path in ("~/.ssh/id_rsa", "$HOME/.bashrc", "../outside.txt", "/workspace/../etc/passwd"):
            dec = self.controller.evaluate_authorization("read_file", {"path": path}, self.ctx)
            self.assertFalse(dec.allowed, f"Should ask for {path}")
            self.assertEqual(dec.status, "ask")

    def test_directory_rules_real_path_symlinks_and_relative_escapes(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"RW:{norm_ws}/**"], self.ctx)

        # 1. Enlace dentro del proyecto que apunta fuera: pide confirmación
        outside_dir = self.base_dir / "outside_dir"
        outside_dir.mkdir(exist_ok=True)
        (outside_dir / "secret.txt").write_text("secret")
        link_out = self.workspace / "link_out"
        if link_out.exists() or link_out.is_symlink():
            link_out.unlink()
        link_out.symlink_to(outside_dir, target_is_directory=True)

        for access_tool, target in (
            ("read_file", str(link_out / "secret.txt")),
            ("read_file", "link_out/secret.txt"),
            ("write_file", str(link_out / "new.txt")),
            ("write_file", "link_out/new.txt")
        ):
            dec = self.controller.evaluate_authorization(access_tool, {"path": target}, self.ctx)
            self.assertFalse(dec.allowed, f"Debe pedir confirmación para enlace que apunta fuera: {target}")
            self.assertEqual(dec.status, "ask")

        # 2. Regla cuya base es un enlace (/link/** -> /real): permite /real/x y /link/x
        real_dir = self.base_dir / "real_dir"
        real_dir.mkdir(exist_ok=True)
        link_to_real = self.base_dir / "link_to_real"
        if link_to_real.exists() or link_to_real.is_symlink():
            link_to_real.unlink()
        link_to_real.symlink_to(real_dir, target_is_directory=True)

        norm_link = zerochat.normalize_directory_path(str(link_to_real))
        norm_real = zerochat.normalize_directory_path(str(real_dir))
        set_rules(self.controller, [f"RW:{norm_link}/**"], self.ctx)

        for access_tool in ("read_file", "write_file"):
            dec_real = self.controller.evaluate_authorization(access_tool, {"path": f"{norm_real}/x.txt"}, self.ctx)
            self.assertTrue(dec_real.allowed, f"Debe permitir ruta real {norm_real}/x.txt")
            dec_link = self.controller.evaluate_authorization(access_tool, {"path": f"{norm_link}/x.txt"}, self.ctx)
            self.assertTrue(dec_link.allowed, f"Debe permitir ruta a través de enlace {norm_link}/x.txt")

        # 3. Ruta relativa con .. que sale del proyecto: pide confirmación
        set_rules(self.controller, [f"RW:{norm_ws}/**"], self.ctx)
        for escape_path in ("../outside.txt", "sub/../../outside.txt", f"{norm_ws}/../outside.txt"):
            for access_tool in ("read_file", "write_file"):
                dec_esc = self.controller.evaluate_authorization(access_tool, {"path": escape_path}, self.ctx)
                self.assertFalse(dec_esc.allowed, f"Debe pedir confirmación para escape ..: {escape_path}")
                self.assertEqual(dec_esc.status, "ask")

    def test_probe_s2_atomic_import_state_validation(self):
        self.controller.clear_session()
        set_global(self.controller, zerochat.GLOBAL_POLICY_ASK)
        set_rules(self.controller, [f"RW:{self.workspace}/**"], self.ctx)

        initial_state = self.controller.export_state(self.ctx)

        # 1. Payload con regla inválida: falla y no modifica globalMcpPolicy (S2)
        invalid_rule_payload = {
            "globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL,
            "directoryRules": ["INVALID_NO_PREFIX_RULE"]
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_rule_payload, self.ctx)
        self.assertEqual(global_policy(self.controller), zerochat.GLOBAL_POLICY_ASK)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

        # 2. Entrada con policy inválida en tools/servers: rechazada sin modificar estado
        invalid_tool_payload = {
            "tools": {"tool_a": {"policy": "unsupported_policy"}}
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_tool_payload, self.ctx)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

        invalid_server_payload = {
            "servers": {"srv_a": {"policy": "invalid"}}
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_server_payload, self.ctx)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

    def test_probe_s3_storage_failure_propagates_to_rpc_without_mutating_memory(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        self.controller.clear_session()
        set_global(self.controller, zerochat.GLOBAL_POLICY_ASK)
        initial_state = self.controller.export_state(self.ctx)

        # Simular fallo en actualización de base de datos (sqlite3.OperationalError)
        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")):
            res, err, _ = handler._dispatch_security("zerochat/security/update", {
                "globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL,
                "tools": {"my_tool": {"policy": "allow"}}
            })
            self.assertIsNone(res)
            self.assertIsNotNone(err)
            self.assertEqual(err["code"], -32603)
            self.assertIn("database is locked", err["message"])

        # La memoria debe haber quedado intacta sin desincronizarse (S3)
        self.assertEqual(global_policy(self.controller), zerochat.GLOBAL_POLICY_ASK)
        self.assertNotIn("my_tool", stored("tools"))
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

    def test_max_policy_entries_exact_boundary(self):
        self.controller.clear_session()
        limit = zerochat.MAX_POLICY_ENTRIES

        # Exact boundary N: 500 entradas permitidas
        tools_n = {f"tool_{i}": {"policy": "allow"} for i in range(limit)}
        payload_n = {"tools": tools_n}
        self.controller.import_state(payload_n, self.ctx)
        self.assertEqual(len(stored("tools")), limit)

        # Exact boundary N+1: 501 entradas rechazadas
        tools_n_plus_1 = {f"tool_{i}": {"policy": "allow"} for i in range(limit + 1)}
        payload_n_plus_1 = {"tools": tools_n_plus_1}
        with self.assertRaises(ValueError) as cm:
            self.controller.import_state(payload_n_plus_1, self.ctx)
        self.assertIn("supera el máximo permitido", str(cm.exception))

    def test_two_controllers_share_state_via_sqlite_and_probe_s1(self):
        # 1. No hay atributos de estado permanente en la instancia del controlador
        ctrl_attrs = set(self.controller.__dict__.keys())
        expected_attrs = {"_lock", "session_global_policy", "session_directory_rules", "session_tools", "session_servers", "pending_challenges"}
        self.assertEqual(ctrl_attrs, expected_attrs, "En memoria solo deben residir lock, sesiones y retos pendientes")

        # 2. Dos instancias ven sus escrituras mutuas en SQLite
        controller_a = zerochat.AccessController()
        controller_b = zerochat.AccessController()

        set_global(controller_a, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        set_tool(controller_a, "tool_shared", zerochat.POLICY_ALLOW)
        set_server(controller_a, "srv_shared", zerochat.POLICY_ALLOW)

        self.assertEqual(global_policy(controller_b), zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        self.assertIsNotNone(tool_entry(controller_b, "tool_shared"))
        self.assertEqual(tool_entry(controller_b, "tool_shared")["policy"], zerochat.POLICY_ALLOW)
        self.assertIsNotNone(server_entry(controller_b, "srv_shared"))
        self.assertEqual(server_entry(controller_b, "srv_shared")["policy"], zerochat.POLICY_ALLOW)

        # Mutación desde B visible en A
        revoke(controller_b, "tools", "tool_shared")
        self.assertIsNone(tool_entry(controller_a, "tool_shared"))

        # 3. Probe S1: import_state seguido de evaluate_authorization conserva lo importado
        controller_a.import_state({
            "globalMcpPolicy": zerochat.GLOBAL_POLICY_ASK,
            "tools": {"probe_tool": {"policy": "allow"}}
        }, self.ctx)
        dec = controller_a.evaluate_authorization("probe_tool", {}, self.ctx)
        self.assertTrue(dec.allowed, "Probe S1: la evaluación posterior al import debe conservar la política importada")
        self.assertEqual(dec.reason, "granular_allow_rule")

    def test_dynamic_project_directory_rule_and_probe_d1(self):
        proj_a = self.base_dir / "proj_a"
        proj_a.mkdir()
        proj_b = self.base_dir / "proj_b"
        proj_b.mkdir()

        ctx_a = zerochat.SecurityContext(workspace_dir=proj_a)
        ctx_b = zerochat.SecurityContext(workspace_dir=proj_b)

        file_a = proj_a / "test.txt"
        file_a.write_text("hello", encoding="utf-8")
        file_b = proj_b / "test.txt"
        file_b.write_text("hello", encoding="utf-8")

        read_a = self.controller.evaluate_authorization("read_file", {"path": str(file_a)}, ctx_a)
        self.assertTrue(read_a.allowed)
        write_a = self.controller.evaluate_authorization("write_file", {"path": str(file_a)}, ctx_a)
        self.assertTrue(write_a.allowed)

        read_b_in_a = self.controller.evaluate_authorization("read_file", {"path": str(file_b)}, ctx_a)
        self.assertFalse(read_b_in_a.allowed)
        self.assertEqual(read_b_in_a.status, "ask")

        exported_a = self.controller.export_state(ctx_a)
        self.assertEqual(exported_a["directoryRules"], [])
        self.assertEqual(exported_a["defaultDirectoryRule"], f"RW:{zerochat.normalize_directory_path(str(proj_a.resolve()))}/**")

        exported_a["directoryRules"].append(exported_a["defaultDirectoryRule"])
        self.controller.import_state(exported_a, context=ctx_a)

        raw_state = zerochat.get_security_policy_data()
        self.assertEqual(raw_state.get("directoryRules"), [], "La regla por defecto nunca debe persistirse en SQLite")

        read_b = self.controller.evaluate_authorization("read_file", {"path": str(file_b)}, ctx_b)
        self.assertTrue(read_b.allowed, "Probe D1: En el nuevo proyecto B debe permitirse lectura sin confirmación")
        write_b = self.controller.evaluate_authorization("write_file", {"path": str(file_b)}, ctx_b)
        self.assertTrue(write_b.allowed, "Probe D1: En el nuevo proyecto B debe permitirse escritura sin confirmación")

        read_a_in_b = self.controller.evaluate_authorization("read_file", {"path": str(file_a)}, ctx_b)
        self.assertFalse(read_a_in_b.allowed, "Probe D1: El proyecto anterior A deja de estar autorizado")
        self.assertEqual(read_a_in_b.status, "ask")

        set_rules(self.controller, rules_of(self.controller, ctx_b) + [f"RW:{zerochat.normalize_directory_path(str(proj_a.resolve()))}/**"], ctx_b)
        rules_after_add = zerochat.get_security_policy_data().get("directoryRules") or []
        self.assertEqual(len(rules_after_add), 1)
        self.assertEqual(rules_after_add[0], f"RW:{zerochat.normalize_directory_path(str(proj_a.resolve()))}/**")

        set_rules(self.controller, rules_of(self.controller, ctx_b) + [self.controller.get_default_directory_rule(ctx_b)], ctx_b)
        rules_after_default = zerochat.get_security_policy_data().get("directoryRules") or []
        self.assertEqual(len(rules_after_default), 1)

        set_rules(self.controller, [], ctx_b)
        self.assertEqual(zerochat.get_security_policy_data().get("directoryRules"), [])

    def test_partial_patch_update_and_revocation(self):
        # Estado inicial con herramientas y servidores (permanentes y de sesión)
        set_tool(self.controller, "t1", zerochat.POLICY_ALLOW)
        set_tool(self.controller, "t2", zerochat.POLICY_DENY)
        set_tool(self.controller, "t_sess", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        set_server(self.controller, "s1", zerochat.POLICY_ALLOW)
        set_rules(self.controller, ["R:/tmp/docs/**"], self.ctx)

        # 1. Parche parcial: añadir t3 sin mencionar t1 ni t2
        res1 = self.controller.import_state({
            "tools": {"t3": {"policy": "allow"}}
        }, self.ctx)
        self.assertIn("t1", res1["tools"])
        self.assertIn("t2", res1["tools"])
        self.assertIn("t3", res1["tools"])
        self.assertIn("t_sess", res1["tools"])
        self.assertIn("s1", res1["servers"])
        self.assertEqual(res1["directoryRules"], ["R:/tmp/docs/**"])

        # 2. null revoca t1 (permanente) y t_sess (sesión) sin tocar t2 ni t3
        res2 = self.controller.import_state({
            "tools": {"t1": None, "t_sess": None}
        }, self.ctx)
        self.assertNotIn("t1", res2["tools"])
        self.assertNotIn("t_sess", res2["tools"])
        self.assertIsNone(tool_entry(self.controller, "t_sess"))
        self.assertIn("t2", res2["tools"])
        self.assertIn("t3", res2["tools"])

        # 3. Clave ausente no cambia nada
        res3 = self.controller.import_state({
            "globalMcpPolicy": zerochat.GLOBAL_POLICY_WORKSPACE_TRUST
        }, self.ctx)
        self.assertEqual(res3["globalMcpPolicy"], zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        self.assertIn("t2", res3["tools"])
        self.assertIn("t3", res3["tools"])
        self.assertIn("s1", res3["servers"])
        self.assertEqual(res3["directoryRules"], ["R:/tmp/docs/**"])

        # 4. Servidor: revocación con null y alta en el mismo parche
        res4 = self.controller.import_state({
            "servers": {"s1": None, "s2": {"policy": "deny"}}
        }, self.ctx)
        self.assertNotIn("s1", res4["servers"])
        self.assertIn("s2", res4["servers"])
        self.assertEqual(res4["servers"]["s2"]["policy"], zerochat.POLICY_DENY)

        # 5. RPC zerochat/security/update aplica el parche y devuelve estado completo
        handler = zerochat.ZeroChatServerHandler
        rpc_result, rpc_err, _ = handler._dispatch_security("zerochat/security/update", {
            "tools": {"t4": {"policy": "allow"}}
        })
        self.assertIsNone(rpc_err)
        self.assertIn("policies", rpc_result)
        self.assertIn("t4", rpc_result["policies"]["tools"])
        self.assertIn("t2", rpc_result["policies"]["tools"])

    def test_security_update_sets_granted_at_and_keeps_it_for_unchanged_grants(self):
        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_000.0):
            first = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
        self.assertEqual(first["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)

        with unittest.mock.patch.object(zerochat.time, "time", return_value=1_700_000_100.0):
            same = self.controller.import_state({"tools": {"t_g": {"policy": "allow"}}}, self.ctx)
            changed = self.controller.import_state({"tools": {"t_g": {"policy": "deny"}}}, self.ctx)
        self.assertEqual(same["tools"]["t_g"]["grantedAt"], 1_700_000_000_000)
        self.assertEqual(changed["tools"]["t_g"]["grantedAt"], 1_700_000_100_000)

    def test_authorize_with_invalid_directory_rule_fails_visibly_and_keeps_challenge(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("custom_tool", {}, self.ctx)
        ch = zerochat.ACCESS_CONTROLLER.create_challenge("custom_tool", {}, dec)

        res, err, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": ch["id"],
            "decision": "allow_always",
            "directoryRule": "INVALID_RULE"
        })
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32602)
        self.assertIn(ch["id"], zerochat.ACCESS_CONTROLLER.pending_challenges)
        self.assertIsNone(tool_entry(zerochat.ACCESS_CONTROLLER, "custom_tool"))

    def test_allow_always_and_directory_rule_are_persisted_in_one_transaction(self):
        self.controller.clear_session()
        limit = zerochat.MAX_POLICY_ENTRIES
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.controller.import_state({"tools": {f"fill_{i}": {"policy": "allow"} for i in range(limit - 1)}}, self.ctx)

        # Herramienta + regla = N+1 entradas: no se guarda ninguna de las dos
        with self.assertRaises(ValueError):
            self.controller.record_decision(
                {"decision": "allow_always", "directoryRule": f"R:{norm_ws}/extra/**"},
                {"toolId": "tool_tx"}, context=self.ctx
            )
        self.assertIsNone(tool_entry(self.controller, "tool_tx"))
        self.assertEqual(rules_of(self.controller, self.ctx), [])

        # Solo la herramienta = N entradas: se guarda
        self.controller.record_decision({"decision": "allow_always"}, {"toolId": "tool_tx"}, context=self.ctx)
        self.assertEqual(tool_entry(self.controller, "tool_tx")["policy"], zerochat.POLICY_ALLOW)

    def test_storage_failure_on_authorize_is_reported_and_tool_not_executed(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("custom_tool", {}, self.ctx)
        ch = zerochat.ACCESS_CONTROLLER.create_challenge("custom_tool", {}, dec)
        with unittest.mock.patch("zerochat.update_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")), \
                unittest.mock.patch.object(zerochat.ZeroChatServerHandler, "_execute_tool") as execute:
            res, err, _ = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": ch["id"],
                "decision": "allow_always"
            })
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32603)
        self.assertIn("database is locked", err["message"])
        execute.assert_not_called()

    def test_corrupt_stored_policies_fail_visibly_and_are_not_overwritten(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        with zerochat.open_storage() as conn:
            conn.execute("INSERT INTO security_policies (id, data_json, updated_at) VALUES ('default', '{corrupt', 0);")
            conn.commit()

        res, err, _ = handler._dispatch_security("zerochat/security/get", {})
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32603)
        self.assertIn("corruptas", err["message"])

        res_up, err_up, _ = handler._dispatch_security("zerochat/security/update", {"globalMcpPolicy": "allow_all"})
        self.assertIsNone(res_up)
        self.assertIn("corruptas", err_up["message"])
        with zerochat.open_storage() as conn:
            raw = conn.execute("SELECT data_json FROM security_policies WHERE id = 'default';").fetchone()["data_json"]
        self.assertEqual(raw, "{corrupt")

        with self.assertRaises(RuntimeError):
            zerochat.ACCESS_CONTROLLER.evaluate_authorization("read_file", {"path": "x.txt"}, self.ctx)

    def test_evaluation_reads_permanent_state_once(self):
        set_global(self.controller, zerochat.GLOBAL_POLICY_WORKSPACE_TRUST)
        with unittest.mock.patch("zerochat.get_security_policy_data", wraps=zerochat.get_security_policy_data) as reader:
            self.controller.evaluate_authorization("run_command", {"command": "cd /tmp && ls"}, self.ctx, server_id="srv")
        self.assertEqual(reader.call_count, 1)

    def test_job_key_is_not_a_challenge_argument_but_reaches_execution(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)
        gate, err, _ = handler._dispatch_local("tools/call", {
            "name": "run_command",
            "arguments": {"command": "echo job"},
            "_meta": {"zerochatJobKey": "inv-1"}
        })
        self.assertIsNone(err)
        self.assertEqual(gate["arguments"], {"command": "echo job"})

        with unittest.mock.patch.object(zerochat.ZeroChatServerHandler, "_execute_tool", return_value=({"content": []}, None, "")) as execute:
            res, err_auth, _ = handler._dispatch_security("zerochat/security/authorize", {
                "challengeId": gate["challengeId"],
                "decision": "allow_once"
            })
        self.assertIsNone(err_auth)
        self.assertTrue(res["authorized"])
        execute.assert_called_once_with("local", "run_command", {"command": "echo job", "job_key": "inv-1"})

    def test_add_directory_rules_appends_in_the_same_patch(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        set_rules(self.controller, [f"R:{norm_ws}/docs/**"], self.ctx)
        res = self.controller.import_state({"addDirectoryRules": [f"RW:{norm_ws}/.zerochat", f"R:{norm_ws}/docs/**"]}, self.ctx)
        self.assertEqual(res["directoryRules"], [f"R:{norm_ws}/docs/**", f"RW:{norm_ws}/.zerochat"])
        with self.assertRaises(ValueError):
            self.controller.import_state({"addDirectoryRules": ["INVALID"]}, self.ctx)

    def test_external_tools_get_no_directory_rule_offer(self):
        dec = self.controller.evaluate_authorization("srv__write_file", {"path": "/tmp/x.txt"}, self.ctx, server_id="srv")
        self.assertEqual(dec.status, "ask")
        self.assertIsNone(dec.rule_offer)

    def test_command_prefixes_are_validated_and_normalized(self):
        res = self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {
            "command": {"allowedPrefixes": ["git status *", "git  status  *", "git status", "git diff *", "git diff --stat"]}
        }}}}, self.ctx)
        self.assertEqual(res["tools"]["run_command"]["constraints"]["command"]["allowedPrefixes"], ["git status *", "git diff *"])

        for bad in ([], ["git; rm"], ["git $(x)"], [""], ["*"], ["g* log"], ["git **"], ["git 'x'"], [3]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {
                    "command": {"allowedPrefixes": bad}
                }}}}, self.ctx)

        limit = zerochat.MAX_COMMAND_PREFIXES
        at_limit = [f"cmd{i}" for i in range(limit)]
        self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {"command": {"allowedPrefixes": at_limit}}}}}, self.ctx)
        with self.assertRaisesRegex(ValueError, "máximo"):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {
                "command": {"allowedPrefixes": at_limit + ["extra"]}
            }}}}, self.ctx)

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
        ]
        for pattern, command, expected in cases:
            with self.subTest(pattern=pattern, command=command):
                self.assertIs(zerochat.matches_command_prefix(command, pattern), expected)

    def test_stored_empty_prefix_list_never_allows_any_command(self):
        zerochat.update_security_policy_data(lambda current: {**(current or {}), "tools": {
            "run_command": {"policy": "allow", "scope": "permanent", "constraints": {"command": {"allowedPrefixes": []}}}
        }})
        dec = self.controller.evaluate_authorization("run_command", {"command": "rm -rf build"}, self.ctx)
        self.assertEqual(dec.status, "ask")
        self.assertEqual(dec.reason, "command_outside_allowed_prefixes")

    def test_edited_prefix_must_cover_the_challenge_command(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        set_global(zerochat.ACCESS_CONTROLLER, zerochat.GLOBAL_POLICY_ASK)
        gate, _, _ = handler._dispatch_local("tools/call", {"name": "run_command", "arguments": {"command": "echo hola mundo"}})
        cid = gate["challengeId"]
        self.assertEqual(gate["ruleOffer"]["command"], "echo hola *")

        res_bad, err_bad, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid, "decision": "allow_always",
            "constraints": {"command": {"allowedPrefixes": ["echo adios"]}}
        })
        self.assertIsNone(res_bad)
        self.assertEqual(err_bad["code"], -32602)
        self.assertIn(cid, zerochat.ACCESS_CONTROLLER.pending_challenges)

        res_ok, err_ok, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid, "decision": "allow_always",
            "constraints": {"command": {"allowedPrefixes": ["echo *"]}}
        })
        self.assertIsNone(err_ok)
        self.assertTrue(res_ok["authorized"])
        stored_prefixes = stored("tools")["run_command"]["constraints"]["command"]["allowedPrefixes"]
        self.assertEqual(stored_prefixes, ["echo *"])

    def _command_challenge(self, command):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        gate, err, _ = handler._dispatch_local("tools/call", {"name": "run_command", "arguments": {"command": command}})
        self.assertIsNone(err)
        self.assertTrue(gate.get("requiresAuthorization"), gate)
        return handler, gate["challengeId"]

    def _authorize_prefix(self, handler, cid, decision, prefix):
        return handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": cid, "decision": decision,
            "constraints": {"command": {"allowedPrefixes": [prefix]}}
        })

    def _status(self, command, ctx=None):
        cwd_ctx = ctx or zerochat.SecurityContext(workspace_dir=Path.cwd().resolve())
        return zerochat.ACCESS_CONTROLLER.evaluate_authorization("run_command", {"command": command}, cwd_ctx).status

    def test_command_prefix_scopes_session_project_and_global(self):
        controller = zerochat.ACCESS_CONTROLLER
        controller.clear_session()
        set_global(controller, zerochat.GLOBAL_POLICY_ASK)
        other_project = zerochat.SecurityContext(workspace_dir=self.base_dir.resolve())
        project = zerochat.normalize_directory_path(str(Path.cwd().resolve()))

        # Sesión: solo ese prefijo, en memoria y sin guardarse
        handler, cid = self._command_challenge("echo uno")
        res, err, _ = self._authorize_prefix(handler, cid, "allow_session", "echo uno *")
        self.assertIsNone(err)
        self.assertTrue(res["authorized"])
        self.assertEqual(self._status("echo uno dos"), "allow")
        self.assertEqual(self._status("echo otro"), "ask")
        self.assertNotIn("run_command", stored("tools"))

        # Proyecto: guardado ligado al proyecto actual; en otro proyecto vuelve a preguntar
        handler, cid = self._command_challenge("printf proyecto")
        res, err, _ = self._authorize_prefix(handler, cid, "allow_project", "printf *")
        self.assertIsNone(err)
        command = stored("tools")["run_command"]["constraints"]["command"]
        self.assertEqual(command["allowedPrefixes"], [])
        self.assertEqual(command["projectPrefixes"], {project: ["printf *"]})
        self.assertEqual(self._status("printf x"), "allow")
        self.assertEqual(self._status("printf x", other_project), "ask")
        # La escritura permanente no retira los prefijos de sesión: se suman
        self.assertEqual(self._status("echo uno dos"), "allow")

        # Global: vale en cualquier proyecto
        handler, cid = self._command_challenge("true global")
        res, err, _ = self._authorize_prefix(handler, cid, "allow_always", "true *")
        self.assertIsNone(err)
        self.assertEqual(self._status("true x", other_project), "allow")

        exported = controller.export_state()["tools"]["run_command"]["constraints"]["command"]
        self.assertEqual(exported["sessionPrefixes"], ["echo uno *"])
        self.assertEqual(exported["allowedPrefixes"], ["true *"])

        # Al acabar la sesión solo quedan los permanentes
        controller.clear_session()
        self.assertEqual(self._status("echo uno dos"), "ask")
        self.assertEqual(self._status("printf x"), "allow")
        self.assertEqual(self._status("true x"), "allow")

    def test_changing_project_clears_session_authorizations_and_challenges(self):
        controller = zerochat.ACCESS_CONTROLLER
        controller.clear_session()
        self.addCleanup(controller.clear_session)
        self.addCleanup(os.chdir, Path.cwd())
        other = self.base_dir / "otro"
        other.mkdir()
        os.chdir(self.workspace)
        set_tool(controller, "custom_tool", zerochat.POLICY_ALLOW, scope=zerochat.SCOPE_SESSION)
        dec = controller.evaluate_authorization("other_tool", {}, self.ctx)
        controller.create_challenge("other_tool", {}, dec)

        # Volver a elegir el mismo proyecto no borra nada.
        zerochat.set_project_directory(str(self.workspace))
        self.assertIsNotNone(tool_entry(controller, "custom_tool"))
        self.assertEqual(len(controller.pending_challenges), 1)

        zerochat.set_project_directory(str(other))
        self.assertIsNone(tool_entry(controller, "custom_tool"))
        self.assertEqual(controller.pending_challenges, {})

    def test_allow_project_requires_a_command_prefix(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("custom_tool", {}, self.ctx)
        ch = zerochat.ACCESS_CONTROLLER.create_challenge("custom_tool", {}, dec)
        res, err, _ = handler._dispatch_security("zerochat/security/authorize", {"challengeId": ch["id"], "decision": "allow_project"})
        self.assertIsNone(res)
        self.assertEqual(err["code"], -32602)
        self.assertIn(ch["id"], zerochat.ACCESS_CONTROLLER.pending_challenges)

    def test_exported_session_prefixes_survive_a_session_overlay(self):
        controller = zerochat.ACCESS_CONTROLLER
        controller.clear_session()
        handler, cid = self._command_challenge("echo capa")
        self._authorize_prefix(handler, cid, "allow_session", "echo capa *")
        snapshot = controller.export_state()
        controller.clear_session()
        controller.apply_session_overlay(snapshot)
        self.assertEqual(self._status("echo capa x"), "allow")

    def test_project_prefixes_are_validated_and_count_towards_the_limit(self):
        with self.assertRaises(ValueError):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": {
                "command": {"allowedPrefixes": [], "projectPrefixes": {"relativo": ["git"]}}
            }}}}, self.ctx)
        limit = zerochat.MAX_COMMAND_PREFIXES
        half = limit // 2
        ok = {"command": {"allowedPrefixes": [f"g{i}" for i in range(half)],
                          "projectPrefixes": {"/proj": [f"p{i}" for i in range(limit - half)]}}}
        self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": ok}}}, self.ctx)
        over = {"command": {**ok["command"], "projectPrefixes": {"/proj": [f"p{i}" for i in range(limit - half + 1)]}}}
        with self.assertRaisesRegex(ValueError, "máximo"):
            self.controller.import_state({"tools": {"run_command": {"policy": "allow", "constraints": over}}}, self.ctx)

if __name__ == "__main__":
    unittest.main()
