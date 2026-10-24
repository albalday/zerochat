import argparse
import io
import sys
import time
import unittest
from unittest.mock import patch

from backend import zerochat


class InteractiveOutput(io.StringIO):
    def isatty(self):
        return True


class ConsoleTest(unittest.TestCase):
    def test_la_ayuda_de_comandos_aparece_tras_un_rato_sin_logs_y_una_vez_por_tanda(self):
        output = InteractiveOutput()
        with patch.object(sys, "stdout", output), patch.object(sys, "stdin", sys.stdin), \
                patch.object(zerochat, "CONSOLE_STATUS_IDLE_SECONDS", 0.02):
            console = zerochat.ConsoleControl(None, argparse.ArgumentParser(prog="zerochat.py"), launch_url=lambda: "http://127.0.0.1:6388/zerochat.html#token=abc")
            self.assertIs(console.enabled, True)
            console.start()
            try:
                console.log("primer log")
                time.sleep(0.04)
                self.assertEqual(output.getvalue().count("Comandos de consola:"), 1)
                self.assertNotIn("ZeroChat activo", output.getvalue())
                time.sleep(0.04)
                self.assertEqual(output.getvalue().count("Comandos de consola:"), 1)
                console.log("segundo log")
                time.sleep(0.04)
                self.assertEqual(output.getvalue().count("Comandos de consola:"), 2)
            finally:
                console.close()
