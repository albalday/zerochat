import os
import shutil
import subprocess
import unittest
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
