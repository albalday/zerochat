import unittest
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
        # Create challenge on the controller used by the handler
        dec = zerochat.ACCESS_CONTROLLER.evaluate_authorization("run_command", {"command": "echo test"}, self.ctx)
        ch = zerochat.ACCESS_CONTROLLER.create_challenge("run_command", {"command": "echo test"}, dec)
        self.assertIsNotNone(ch["id"])
        self.assertFalse(ch["authorized"])

        # Authorize via RPC
        auth_params = {
            "challengeId": ch["id"],
            "decision": "allow_once"
        }
        res, err, info = handler._dispatch_security("zerochat/security/authorize", auth_params)
        self.assertIsNone(err)
        self.assertEqual(res["authorized"], True)
        self.assertEqual(res["challengeId"], ch["id"])

        # Challenge can be consumed
        consumed = zerochat.ACCESS_CONTROLLER.consume_challenge(ch["id"])
        self.assertIsNotNone(consumed)
        # allow_once consumed once
        self.assertIsNone(zerochat.ACCESS_CONTROLLER.consume_challenge(ch["id"]))


if __name__ == "__main__":
    unittest.main()
