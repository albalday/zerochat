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

    def test_sin_visor_en_git_se_propone_el_primero_instalado_y_solo_se_configuran_conocidos(self):
        # Las órdenes propuestas son las que configure_gui_diff_tool aplica después.
        with patch("shutil.which", which_only("gvim", "meld", "webdiff")):
            self.assertEqual(zerochat.detect_gui_diff_tool(), {"tool": "meld", "install": False, "commands": ["git config --global diff.guitool meld"]})
            self.assertEqual(zerochat.configure_gui_diff_tool("meld"), {"tool": "meld"})
            self.assertEqual(git_get("diff.guitool"), "meld")
            for bad in ("nano", None, ["meld"], "kompare"):
                with self.subTest(tool=bad), self.assertRaises(ValueError):
                    zerochat.configure_gui_diff_tool(bad)
            self.assertEqual(git_get("diff.guitool"), "meld")
        REAL_RUN(["git", "config", "--global", "--unset", "diff.guitool"], check=True)
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

    def test_generate_file_diff_validations_working_tree_and_commit(self):
        for bad_path in ("", "   ", "a" * (zerochat.MAX_PATH_LENGTH + 1), "/path/to/nonexistent/file_xyz.txt"):
            with self.subTest(bad_path=bad_path), self.assertRaises(ValueError):
                zerochat.generate_file_diff(bad_path, zerochat.project_context())
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo_path = Path(tmp_dir).resolve()
            subprocess.run(["git", "init"], cwd=str(repo_path), check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=str(repo_path), check=True)

            target_file = repo_path / "sample.txt"
            target_file.write_text("line 1\nline 2\n", encoding="utf-8")

            # 1. Untracked file (working tree diff vs /dev/null)
            res_untracked = zerochat.generate_file_diff(str(target_file), zerochat.project_context())
            self.assertTrue(res_untracked["success"])
            self.assertTrue(res_untracked["has_diff"])
            self.assertEqual(res_untracked["mode"], "working_tree")
            self.assertIn("+line 1", res_untracked["diff"])
            self.assertIn("line 1", res_untracked["html"])

            # 2. Commit file -> clean working tree
            subprocess.run(["git", "add", "sample.txt"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "-m", "initial commit"], cwd=str(repo_path), check=True, capture_output=True)

            res_clean = zerochat.generate_file_diff(str(target_file), zerochat.project_context())
            self.assertTrue(res_clean["success"])
            self.assertFalse(res_clean["has_diff"])
            self.assertTrue(res_clean["has_commit_history"])

            # 3. Commit fallback -> returns diff of the commit
            res_fallback = zerochat.generate_file_diff(str(target_file), zerochat.project_context(), commit_fallback=True)
            self.assertTrue(res_fallback["success"])
            self.assertTrue(res_fallback["has_diff"])
            self.assertEqual(res_fallback["mode"], "commit")
            self.assertIn("+line 1", res_fallback["diff"])
            self.assertIn("<!DOCTYPE html>", res_fallback["html"])

            # 4. Modify file -> working tree diff vs HEAD
            target_file.write_text("line 1\nline 2 modified\nline 3\n", encoding="utf-8")
            res_modified = zerochat.generate_file_diff(str(target_file), zerochat.project_context())
            self.assertTrue(res_modified["success"])
            self.assertTrue(res_modified["has_diff"])
            self.assertEqual(res_modified["mode"], "working_tree")
            self.assertIn("-line 2", res_modified["diff"])
            self.assertIn("+line 2 modified", res_modified["diff"])

            # 5. open_file_diff uses generate_file_diff by default and embeds full file button
            res_open = zerochat.open_file_diff(str(target_file), zerochat.project_context())
            self.assertTrue(res_open["success"])
            self.assertTrue(res_open["has_diff"])
            self.assertIn("html", res_open)
            self.assertIn("btn-full-file", res_open["html"])

            # 6. Tope de bytes: la salida de git diff cabe en N y se corta con aviso en N+1; el archivo entero
            # del visor solo va si cabe.
            size = len(res_modified["diff"].encode("utf-8"))
            with patch.object(zerochat, "DIFF_MAX_BYTES", size):
                exact = zerochat.generate_file_diff(str(target_file), zerochat.project_context())
                self.assertEqual((exact["truncated"], exact["diff"]), (False, res_modified["diff"]))
            with patch.object(zerochat, "DIFF_MAX_BYTES", size - 1):
                cut = zerochat.generate_file_diff(str(target_file), zerochat.project_context())
                self.assertTrue(cut["truncated"])
                self.assertTrue(cut["diff"].endswith(f"[Diff truncated at {size - 1} bytes]\n"))
                self.assertNotIn("+line 3", cut["diff"])
            file_size = target_file.stat().st_size
            for limit, embedded in ((file_size, True), (file_size - 1, False)):
                with patch.object(zerochat, "DIFF_MAX_BYTES", limit):
                    html_out = zerochat.generate_file_diff(str(target_file), zerochat.project_context())["html"]
                    self.assertEqual('onclick="openFullFile()"' in html_out, embedded, limit)

            # 7. Default context lines is 5
            lines_file = repo_path / "context_test.txt"
            lines_file.write_text("".join(f"line {i}\n" for i in range(1, 21)), encoding="utf-8")
            subprocess.run(["git", "add", "context_test.txt"], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "-m", "add context test"], cwd=str(repo_path), check=True, capture_output=True)

            # Modify line 10
            modified_lines = [f"line {i}\n" for i in range(1, 21)]
            modified_lines[9] = "line 10 MODIFIED\n"
            lines_file.write_text("".join(modified_lines), encoding="utf-8")

            res_context = zerochat.generate_file_diff(str(lines_file), zerochat.project_context())
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



class GuiFileDiffCommandTest(unittest.TestCase):
    """git difftool compara lo mismo que el visor propio: el archivo nuevo con /dev/null, el cambiado con HEAD
    y, sin cambios y con commit_fallback, su último commit (el primero, con el árbol vacío)."""

    def test_difftool_recibe_las_revisiones_de_cada_caso(self):
        repo = use_data_dir(self) / "repo"
        repo.mkdir()
        for args in (["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["config", "diff.guitool", "meld"]):
            REAL_RUN(["git", *args], cwd=repo, check=True, capture_output=True)
        target = repo / "a.txt"
        target.write_text("uno\n", encoding="utf-8")
        ctx = zerochat.SecurityContext(repo.resolve())
        launched = []

        real_popen = subprocess.Popen

        def fake_popen(cmd, **kwargs):
            if "difftool" not in cmd:
                return real_popen(cmd, **kwargs)
            launched.append(cmd[cmd.index("--gui") + 1:])
            return type("Proc", (), {"pid": 1, "wait": lambda self: 0})()

        with patch.object(zerochat.subprocess, "Popen", fake_popen):
            self.assertEqual(zerochat.open_file_diff(str(target), ctx, gui=True)["mode"], "working_tree")
            REAL_RUN(["git", "add", "a.txt"], cwd=repo, check=True)
            REAL_RUN(["git", "commit", "-m", "1"], cwd=repo, check=True, capture_output=True)
            self.assertIs(zerochat.open_file_diff(str(target), ctx, gui=True)["has_diff"], False)
            commit = zerochat.open_file_diff(str(target), ctx, commit_fallback=True, gui=True)
            target.write_text("dos\n", encoding="utf-8")
            zerochat.open_file_diff(str(target), ctx, gui=True)
        self.assertEqual(commit["mode"], "commit")
        self.assertEqual(launched, [
            ["--no-index", "--", os.devnull, str(target)],
            [zerochat.GIT_EMPTY_TREE, commit["commit"], "--", str(target)],
            ["HEAD", "--", str(target)],
        ])
        # Un diff histórico fallido no cae al fichero actual del árbol de trabajo (M98-T26).
        self.assertIsNone(zerochat._full_file_bytes("git", repo, target, "inexistente.txt", commit["commit"]))
