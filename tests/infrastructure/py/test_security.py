import os
import sqlite3
import unittest
import unittest.mock
from pathlib import Path

from backend import use_data_dir, zerochat


class SecurityContextTest(unittest.TestCase):
    def setUp(self):
        self.base_dir = use_data_dir(self)
        self.workspace = self.base_dir / "workspace"
        self.workspace.mkdir()
        (self.workspace / "file.txt").write_text("ok", encoding="utf-8")
        self.ctx = zerochat.SecurityContext(workspace_dir=self.workspace, user_id="user1", session_id="sess1")

    def test_context_fields_and_defaults(self):
        ctx_default = zerochat.SecurityContext()
        self.assertIsNotNone(ctx_default.workspace_dir)
        self.assertIsNone(ctx_default.user_id)
        self.assertIsNone(ctx_default.session_id)
        self.assertEqual(self.ctx.user_id, "user1")
        self.assertEqual(self.ctx.session_id, "sess1")

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
        self.assertEqual(self.controller.global_policy, zerochat.GLOBAL_POLICY_ASK)
        dec = self.controller.evaluate_authorization("run_command", {"command": "ls"}, self.ctx)
        self.assertFalse(dec.allowed)
        self.assertTrue(dec.requires_approval)
        self.assertEqual(dec.status, "ask")

    def test_global_allow_all(self):
        self.controller.global_policy = zerochat.GLOBAL_POLICY_ALLOW_ALL
        dec = self.controller.evaluate_authorization("run_command", {"command": "rm -rf /"}, self.ctx)
        self.assertTrue(dec.allowed)
        self.assertEqual(dec.status, "allow")
        self.assertEqual(dec.reason, "mcp_global_allow_all")

    def test_blacklist_takes_precedence_over_allow_all(self):
        self.controller.global_policy = zerochat.GLOBAL_POLICY_ALLOW_ALL
        self.controller.set_tool_policy("run_command", zerochat.TOOL_POLICY_DENY)
        dec = self.controller.evaluate_authorization("run_command", {"command": "echo 1"}, self.ctx)
        self.assertFalse(dec.allowed)
        self.assertEqual(dec.status, "deny")
        self.assertEqual(dec.reason, "granular_deny_rule")

    def test_server_blacklist(self):
        self.controller.set_server_policy("srv1", zerochat.SERVER_POLICY_DENY)
        dec = self.controller.evaluate_authorization("custom_tool", {}, self.ctx, server_id="srv1")
        self.assertFalse(dec.allowed)
        self.assertEqual(dec.status, "deny")
        self.assertEqual(dec.reason, "server_deny_rule")

    def test_directory_rules_evaluation(self):
        # Default directory rule is RW for workspace
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.controller.set_directory_rules([f"R:{norm_ws}/docs/**", f"W:{norm_ws}/src/**"], self.ctx)

        read_docs = self.controller.evaluate_authorization("read_file", {"path": f"{norm_ws}/docs/readme.md"}, self.ctx)
        self.assertTrue(read_docs.allowed)

        write_docs = self.controller.evaluate_authorization("write_file", {"path": f"{norm_ws}/docs/readme.md"}, self.ctx)
        self.assertFalse(write_docs.allowed)
        self.assertEqual(write_docs.status, "ask")

        write_src = self.controller.evaluate_authorization("write_file", {"path": f"{norm_ws}/src/main.py"}, self.ctx)
        self.assertTrue(write_src.allowed)

    def test_command_constraints_prefixes_and_chaining(self):
        self.controller.set_tool_policy("run_command", zerochat.TOOL_POLICY_ALLOW, constraints={
            "command": {
                "allowedPrefixes": ["git", "npm"],
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
        self.controller.global_policy = zerochat.GLOBAL_POLICY_WORKSPACE_TRUST
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

        # allow_session records in session_tools
        self.controller.record_decision(
            {"decision": "allow_session"},
            {"toolId": "tool_x", "serverName": "srv_x"},
            context=self.ctx
        )
        self.assertIsNotNone(self.controller.session_tools.get("tool_x"))
        self.assertIsNone(self.controller.tools.get("tool_x"))

        # allow_always records in tools
        self.controller.record_decision(
            {"decision": "allow_always", "directoryRule": f"R:{norm_ws}/extra/**"},
            {"toolId": "tool_y"},
            context=self.ctx
        )
        self.assertIsNotNone(self.controller.tools.get("tool_y"))
        self.assertIn(f"R:{norm_ws}/extra/**", self.controller.get_directory_rules(self.ctx))

        # Clear session clears session_tools but preserves permanent
        self.controller.clear_session()
        self.assertIsNone(self.controller.session_tools.get("tool_x"))
        self.assertIsNotNone(self.controller.tools.get("tool_y"))

    def test_persistence_in_sqlite(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        state = {
            "globalMcpPolicy": "workspace_trust",
            "directoryRules": [f"R:{norm_ws}/docs/**", f"W:{norm_ws}/output/**"],
            "tools": {"tool_saved": {"policy": "allow", "serverName": "srv"}},
            "servers": {"srv_saved": {"policy": "deny"}}
        }
        res = zerochat.save_security_policy_data(state)
        self.assertEqual(res["id"], "default")

        loaded = zerochat.get_security_policy_data("default")
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
        self.assertFalse(ch["authorized"])

        # zerochat/security/authorize autoriza, consume y ejecuta el reto en una sola operación
        res, err, info = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": ch["id"],
            "decision": "allow_once"
        })
        self.assertIsNone(err)
        self.assertEqual(res["authorized"], True)
        self.assertIn("test", res["result"]["content"][0]["text"])

        # El reto ya quedó consumido y no puede reutilizarse
        self.assertIsNone(zerochat.ACCESS_CONTROLLER.consume_challenge(ch["id"]))
        res_again, err_again, _ = handler._dispatch_security("zerochat/security/authorize", {
            "challengeId": ch["id"],
            "decision": "allow_once"
        })
        self.assertIsNone(res_again)
        self.assertEqual(err_again["code"], -32002)

    def test_tools_call_ignores_challenge_id_and_challenge_is_single_use(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        zerochat.ACCESS_CONTROLLER.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)
        zerochat.ACCESS_CONTROLLER.set_directory_rules([], self.ctx)

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
        self.assertIsNone(zerochat.ACCESS_CONTROLLER.get_tool_policy("run_command"))

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
        zerochat.ACCESS_CONTROLLER.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)

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
        zerochat.ACCESS_CONTROLLER.servers.clear()
        zerochat.ACCESS_CONTROLLER.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)

        # Probe C2a: confiar en el servidor "playwright" autoriza playwright__x pero NO otro__y
        zerochat.ACCESS_CONTROLLER.set_server_policy("playwright", zerochat.SERVER_POLICY_ALLOW)
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
        zerochat.ACCESS_CONTROLLER.servers.clear()
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
        self.assertEqual(zerochat.ACCESS_CONTROLLER.servers, {})

    def test_probe_c3_run_command_allow_always_requires_constraints(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        zerochat.ACCESS_CONTROLLER.clear_session()
        zerochat.ACCESS_CONTROLLER.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)

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
            "constraints": {"command": {"allowedPrefixes": ["ls"]}}
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
        try:
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
                pol = zerochat.ACCESS_CONTROLLER.get_tool_policy(dt)
                self.assertIsNotNone(pol)
                self.assertEqual(pol["policy"], "allow")
            custom_pol = zerochat.ACCESS_CONTROLLER.get_tool_policy("custom_tool")
            self.assertIsNotNone(custom_pol)
            self.assertEqual(custom_pol["policy"], "allow")
            self.assertEqual(zerochat.ACCESS_CONTROLLER.global_policy, "allow_all")
        finally:
            zerochat.RUN_SESSION = None
            zerochat.reset_session_credentials()



    def test_get_rule_offer_commands_and_directories(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.controller.set_directory_rules([f"R:{norm_ws}/**"], self.ctx)

        # Command offer keeps executable path / prefix
        dec_cmd = self.controller.evaluate_authorization("run_command", {"command": "./myui --port 8080"}, self.ctx)
        self.assertIsNotNone(dec_cmd.rule_offer)
        self.assertEqual(dec_cmd.rule_offer["type"], "command")
        self.assertEqual(dec_cmd.rule_offer["command"], "./myui")
        self.assertEqual(dec_cmd.rule_offer["constraints"]["command"]["allowedPrefixes"], ["./myui"])

        # Command with cd prefix
        dec_cd = self.controller.evaluate_authorization("run_command", {"command": "cd /tmp && git status"}, self.ctx)
        self.assertIsNotNone(dec_cd.rule_offer)
        self.assertEqual(dec_cd.rule_offer["command"], "git")
        self.assertEqual(dec_cd.rule_offer["constraints"]["command"]["allowedPrefixes"], ["git"])

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
        self.controller.set_directory_rules([f"R:{norm_ws}/**", f"W:{norm_ws}/**"], self.ctx)
        self.controller.set_tool_policy("run_command", zerochat.TOOL_POLICY_ALLOW, constraints={
            "command": {"allowedPrefixes": ["git"], "allowChaining": False, "allowPipes": False}
        })

        # cd inside workspace with allowed git command
        dec_cd_ok = self.controller.evaluate_authorization("run_command", {"command": f"cd {norm_ws} && git status"}, self.ctx)
        self.assertTrue(dec_cd_ok.allowed)

        # cd outside directory rules asks
        dec_cd_out = self.controller.evaluate_authorization("run_command", {"command": "cd /etc && git status"}, self.ctx)
        self.assertFalse(dec_cd_out.allowed)
        self.assertEqual(dec_cd_out.status, "ask")

    def test_unresolved_references_ask_in_workspace_trust(self):
        self.controller.global_policy = zerochat.GLOBAL_POLICY_WORKSPACE_TRUST
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.controller.set_directory_rules([f"RW:{norm_ws}/**"], self.ctx)

        for path in ("~/.ssh/id_rsa", "$HOME/.bashrc", "../outside.txt", "/workspace/../etc/passwd"):
            dec = self.controller.evaluate_authorization("read_file", {"path": path}, self.ctx)
            self.assertFalse(dec.allowed, f"Should ask for {path}")
            self.assertEqual(dec.status, "ask")

    def test_directory_rules_real_path_symlinks_and_relative_escapes(self):
        norm_ws = zerochat.normalize_directory_path(str(self.workspace))
        self.controller.set_directory_rules([f"RW:{norm_ws}/**"], self.ctx)

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
        self.controller.set_directory_rules([f"RW:{norm_link}/**"], self.ctx)

        for access_tool in ("read_file", "write_file"):
            dec_real = self.controller.evaluate_authorization(access_tool, {"path": f"{norm_real}/x.txt"}, self.ctx)
            self.assertTrue(dec_real.allowed, f"Debe permitir ruta real {norm_real}/x.txt")
            dec_link = self.controller.evaluate_authorization(access_tool, {"path": f"{norm_link}/x.txt"}, self.ctx)
            self.assertTrue(dec_link.allowed, f"Debe permitir ruta a través de enlace {norm_link}/x.txt")

        # 3. Ruta relativa con .. que sale del proyecto: pide confirmación
        self.controller.set_directory_rules([f"RW:{norm_ws}/**"], self.ctx)
        for escape_path in ("../outside.txt", "sub/../../outside.txt", f"{norm_ws}/../outside.txt"):
            for access_tool in ("read_file", "write_file"):
                dec_esc = self.controller.evaluate_authorization(access_tool, {"path": escape_path}, self.ctx)
                self.assertFalse(dec_esc.allowed, f"Debe pedir confirmación para escape ..: {escape_path}")
                self.assertEqual(dec_esc.status, "ask")

    def test_probe_s2_atomic_import_state_validation(self):
        self.controller.clear_session()
        self.controller.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)
        self.controller.set_directory_rules([f"RW:{self.workspace}/**"], self.ctx)

        initial_state = self.controller.export_state(self.ctx)

        # 1. Payload con regla inválida: falla y no modifica globalMcpPolicy (S2)
        invalid_rule_payload = {
            "globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL,
            "directoryRules": ["INVALID_NO_PREFIX_RULE"]
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_rule_payload, self.ctx, persist=False)
        self.assertEqual(self.controller.global_policy, zerochat.GLOBAL_POLICY_ASK)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

        # 2. Entrada con policy inválida en tools/servers: rechazada sin modificar estado
        invalid_tool_payload = {
            "tools": {"tool_a": {"policy": "unsupported_policy"}}
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_tool_payload, self.ctx, persist=False)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

        invalid_server_payload = {
            "servers": {"srv_a": {"policy": "invalid"}}
        }
        with self.assertRaises(ValueError):
            self.controller.import_state(invalid_server_payload, self.ctx, persist=False)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

    def test_probe_s3_storage_failure_propagates_to_rpc_without_mutating_memory(self):
        handler = zerochat.ZeroChatServerHandler.__new__(zerochat.ZeroChatServerHandler)
        self.controller.clear_session()
        self.controller.set_global_policy(zerochat.GLOBAL_POLICY_ASK, self.ctx)
        initial_state = self.controller.export_state(self.ctx)

        # Simular fallo en save_security_policy_data (sqlite3.OperationalError)
        with unittest.mock.patch("zerochat.save_security_policy_data", side_effect=sqlite3.OperationalError("database is locked")):
            res, err, _ = handler._dispatch_security("zerochat/security/update", {
                "globalMcpPolicy": zerochat.GLOBAL_POLICY_ALLOW_ALL,
                "tools": {"my_tool": {"policy": "allow"}}
            })
            self.assertIsNone(res)
            self.assertIsNotNone(err)
            self.assertEqual(err["code"], -32603)
            self.assertIn("database is locked", err["message"])

        # La memoria debe haber quedado intacta sin desincronizarse (S3)
        self.assertEqual(self.controller.global_policy, zerochat.GLOBAL_POLICY_ASK)
        self.assertNotIn("my_tool", self.controller.tools)
        self.assertEqual(self.controller.export_state(self.ctx), initial_state)

    def test_max_policy_entries_exact_boundary(self):
        self.controller.clear_session()
        limit = zerochat.MAX_POLICY_ENTRIES

        # Exact boundary N: 500 entradas permitidas
        tools_n = {f"tool_{i}": {"policy": "allow"} for i in range(limit)}
        payload_n = {"tools": tools_n}
        self.controller.import_state(payload_n, self.ctx, persist=False)
        self.assertEqual(len(self.controller.tools), limit)

        # Exact boundary N+1: 501 entradas rechazadas
        tools_n_plus_1 = {f"tool_{i}": {"policy": "allow"} for i in range(limit + 1)}
        payload_n_plus_1 = {"tools": tools_n_plus_1}
        with self.assertRaises(ValueError) as cm:
            self.controller.import_state(payload_n_plus_1, self.ctx, persist=False)
        self.assertIn("supera el máximo permitido", str(cm.exception))

if __name__ == "__main__":
    unittest.main()
