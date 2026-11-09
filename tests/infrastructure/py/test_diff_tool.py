import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import use_data_dir, zerochat

REAL_WHICH = shutil.which
REAL_RUN = subprocess.run


def which_only(*names):
    return lambda cmd: REAL_WHICH(cmd) if cmd == "git" else (f"/usr/bin/{cmd}" if cmd in names else None)


def git_get(key):
    return REAL_RUN(["git", "config", "--global", "--get", key], capture_output=True, text=True).stdout.strip()


class GuiDiffToolTest(unittest.TestCase):
    def setUp(self):
        data_dir = use_data_dir(self)
        patcher = patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(data_dir / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_sin_visor_en_git_se_propone_el_primero_instalado(self):
        # Las órdenes propuestas son las que configure_gui_diff_tool aplica después.
        with patch("shutil.which", which_only("gvim", "meld", "webdiff")):
            self.assertEqual(zerochat.detect_gui_diff_tool(), {"tool": "meld", "install": False, "commands": ["git config --global diff.guitool meld"]})
        with patch("shutil.which", which_only("code", "meld")):
            self.assertEqual(zerochat.detect_gui_diff_tool()["tool"], "vscode")
        with patch("shutil.which", which_only("webdiff")):
            self.assertEqual(zerochat.detect_gui_diff_tool(), {"tool": "webdiff", "install": False, "commands": [
                """git config --global difftool.webdiff.cmd '"/usr/bin/webdiff" "$LOCAL" "$REMOTE"'""",
                "git config --global diff.guitool webdiff",
            ]})

    def test_sin_ninguno_se_instala_webdiff_en_el_entorno_de_zerochat(self):
        venv_python = zerochat.get_venv_python(zerochat.get_venv_dir())
        venv_webdiff = zerochat._venv_webdiff()
        pip_result = subprocess.CompletedProcess([], 1, "", "boom")

        def fake_run(cmd, **kwargs):
            if cmd[1:4] != ["-m", "pip", "install"]:
                return REAL_RUN(cmd, **kwargs)
            self.assertEqual((cmd[0], cmd[4]), (str(venv_python), zerochat.WEBDIFF_REQUIREMENT))
            if pip_result.returncode == 0:
                venv_webdiff.touch()
            return pip_result

        def fake_venv():
            venv_python.parent.mkdir(parents=True, exist_ok=True)
            venv_python.touch()

        with patch("shutil.which", which_only()), patch("subprocess.run", side_effect=fake_run), \
                patch.object(zerochat, "ensure_virtual_environment", side_effect=fake_venv):
            proposal = zerochat.detect_gui_diff_tool()
            self.assertEqual((proposal["tool"], proposal["install"]), ("webdiff", True))
            with self.assertRaisesRegex(RuntimeError, "boom"):
                zerochat.configure_gui_diff_tool("webdiff")
            self.assertEqual(git_get("diff.guitool"), "")
            pip_result.returncode = 0
            self.assertEqual(zerochat.configure_gui_diff_tool("webdiff"), {"tool": "webdiff"})
            self.assertEqual(git_get("diff.guitool"), "webdiff")
            self.assertEqual(git_get("difftool.webdiff.cmd"), f'"{venv_webdiff}" "$LOCAL" "$REMOTE"')
            self.assertEqual(zerochat.detect_gui_diff_tool(), {**proposal, "install": False})
        # El webdiff del entorno de ZeroChat tiene prioridad sobre el del PATH.
        with patch("shutil.which", which_only("webdiff")):
            self.assertIn(str(venv_webdiff), zerochat.detect_gui_diff_tool()["commands"][0])

    def test_solo_se_configuran_visores_conocidos(self):
        with patch("shutil.which", which_only("meld")):
            self.assertEqual(zerochat.configure_gui_diff_tool("meld"), {"tool": "meld"})
            self.assertEqual(git_get("diff.guitool"), "meld")
            for bad in ("nano", None, ["meld"], "kompare"):
                with self.subTest(tool=bad), self.assertRaises(ValueError):
                    zerochat.configure_gui_diff_tool(bad)
            self.assertEqual(git_get("diff.guitool"), "meld")


class BuiltinDiffTest(unittest.TestCase):
    def test_render_diff_html_escapes_and_formats(self):
        sample_diff = """diff --git a/test.txt b/test.txt
index 1234567..89abcdef 100644
--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,3 @@
 context
-<script>alert('xss')</script>
+<b>safe line</b>
+added line"""
        html_out = zerochat.render_diff_html(
            sample_diff,
            "test.txt",
            "src/test.txt",
            mode="working_tree",
            full_file_bytes=b"sample full content\n"
        )
        self.assertIn("<!DOCTYPE html>", html_out)
        self.assertIn("test.txt", html_out)
        self.assertIn("src/test.txt", html_out)
        self.assertIn("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;", html_out)
        self.assertNotIn("<script>alert", html_out)
        self.assertIn("&lt;b&gt;safe line&lt;/b&gt;", html_out)
        self.assertIn("row-add", html_out)
        self.assertIn("row-del", html_out)
        self.assertIn("row-hunk", html_out)
        self.assertIn("+2", html_out)
        self.assertIn("-1", html_out)
        self.assertIn("btn-full-file", html_out)
        self.assertIn("Abrir fichero completo", html_out)
        self.assertIn("openFullFile()", html_out)

    def test_generate_file_diff_validations(self):
        with self.assertRaises(ValueError):
            zerochat.generate_file_diff("")
        with self.assertRaises(ValueError):
            zerochat.generate_file_diff("   ")
        with self.assertRaises(ValueError):
            zerochat.generate_file_diff("a" * (zerochat.MAX_PATH_LENGTH + 1))
        with self.assertRaises(ValueError):
            zerochat.generate_file_diff("/path/to/nonexistent/file_xyz.txt")

    def test_generate_file_diff_working_tree_and_commit(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo_path = Path(tmp_dir).resolve()
            subprocess.run(["git", "init"], cwd=str(repo_path), check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=str(repo_path), check=True)

            target_file = repo_path / "sample.txt"
            target_file.write_text("line 1\nline 2\n", encoding="utf-8")

            # 1. Untracked file (working tree diff vs /dev/null)
            res_untracked = zerochat.generate_file_diff(str(target_file))
            self.assertTrue(res_untracked["success"])
            self.assertTrue(res_untracked["has_diff"])
            self.assertEqual(res_untracked["mode"], "working_tree")
            self.assertIn("+line 1", res_untracked["diff"])
            self.assertIn("line 1", res_untracked["html"])

            # 2. Commit file -> clean working tree
            subprocess.run(["git", "add", "sample.txt"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "-m", "initial commit"], cwd=str(repo_path), check=True, capture_output=True)

            res_clean = zerochat.generate_file_diff(str(target_file))
            self.assertTrue(res_clean["success"])
            self.assertFalse(res_clean["has_diff"])
            self.assertTrue(res_clean["has_commit_history"])

            # 3. Commit fallback -> returns diff of the commit
            res_fallback = zerochat.generate_file_diff(str(target_file), commit_fallback=True)
            self.assertTrue(res_fallback["success"])
            self.assertTrue(res_fallback["has_diff"])
            self.assertEqual(res_fallback["mode"], "commit")
            self.assertIn("+line 1", res_fallback["diff"])
            self.assertIn("<!DOCTYPE html>", res_fallback["html"])

            # 4. Modify file -> working tree diff vs HEAD
            target_file.write_text("line 1\nline 2 modified\nline 3\n", encoding="utf-8")
            res_modified = zerochat.generate_file_diff(str(target_file))
            self.assertTrue(res_modified["success"])
            self.assertTrue(res_modified["has_diff"])
            self.assertEqual(res_modified["mode"], "working_tree")
            self.assertIn("-line 2", res_modified["diff"])
            self.assertIn("+line 2 modified", res_modified["diff"])

            # 5. open_file_diff uses generate_file_diff by default and embeds full file button
            res_open = zerochat.open_file_diff(str(target_file))
            self.assertTrue(res_open["success"])
            self.assertTrue(res_open["has_diff"])
            self.assertIn("html", res_open)
            self.assertIn("btn-full-file", res_open["html"])

            # 6. Default context lines is 5
            lines_file = repo_path / "context_test.txt"
            lines_file.write_text("".join(f"line {i}\n" for i in range(1, 21)), encoding="utf-8")
            subprocess.run(["git", "add", "context_test.txt"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "-m", "add context test"], cwd=str(repo_path), check=True, capture_output=True)

            # Modify line 10
            modified_lines = [f"line {i}\n" for i in range(1, 21)]
            modified_lines[9] = "line 10 MODIFIED\n"
            lines_file.write_text("".join(modified_lines), encoding="utf-8")

            res_context = zerochat.generate_file_diff(str(lines_file))
            diff_text = res_context["diff"]
            # 5 lines before: lines 5, 6, 7, 8, 9
            self.assertIn("line 5", diff_text)
            self.assertIn("line 9", diff_text)
            # 5 lines after: lines 11, 12, 13, 14, 15
            self.assertIn("line 11", diff_text)
            self.assertIn("line 15", diff_text)
            # Lines further away (line 3 and line 16) should not be in the hunk
            self.assertNotIn("line 3\n", diff_text)
            self.assertNotIn("line 16\n", diff_text)

