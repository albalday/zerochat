import base64
import os
import unittest
from unittest.mock import patch

from backend import use_data_dir, zerochat


class ProjectFilesTest(unittest.TestCase):
    """Navegador de ficheros de la interfaz: zerochat/files/* no sale de la carpeta del proyecto."""

    def setUp(self):
        data_dir = use_data_dir(self)
        self.root = (data_dir / "proyecto").resolve()
        (self.root / "src").mkdir(parents=True)
        (self.root / "Docs").mkdir()
        (self.root / "README.md").write_text("# Hola\n", encoding="utf-8", newline="\n")
        (self.root / "src" / "main.py").write_text("print('hola')\n", encoding="utf-8", newline="\n")
        self.outside = (data_dir / "fuera").resolve()
        self.outside.mkdir()
        (self.outside / "secreto.txt").write_text("no\n", encoding="utf-8", newline="\n")
        self.ctx = zerochat.SecurityContext(self.root)

    def call(self, method, **params):
        result, error, _ = zerochat.dispatch_files(method, params, self.ctx)
        return result, error

    def test_lista_carpetas_primero_por_nombre_con_tamano_y_fecha(self):
        listing, error = self.call("zerochat/files/list")
        self.assertIsNone(error)
        self.assertEqual(listing["path"], "")
        self.assertEqual([(e["name"], e["type"]) for e in listing["entries"]],
                         [("Docs", "dir"), ("src", "dir"), ("README.md", "file")])
        readme = listing["entries"][2]
        self.assertEqual(readme["size"], 7)
        self.assertIsInstance(readme["modified"], int)
        self.assertIsNone(listing["entries"][0]["size"])
        nested, _ = self.call("zerochat/files/list", path="src")
        self.assertEqual((nested["path"], [e["name"] for e in nested["entries"]]), ("src", ["main.py"]))

    def test_el_tope_de_entradas_por_carpeta_se_respeta_en_el_borde(self):
        many = self.root / "muchos"
        many.mkdir()
        for i in range(4):
            (many / f"f{i}.txt").write_text("x", encoding="utf-8", newline="\n")
        for limit, truncated in ((4, False), (3, True)):
            with self.subTest(limit=limit), patch.object(zerochat, "MAX_LIST_ENTRIES", limit):
                listing, _ = self.call("zerochat/files/list", path="muchos")
                self.assertEqual((len(listing["entries"]), listing["total"], listing["truncated"]), (min(limit, 4), 4, truncated))

    def test_ninguna_ruta_sale_de_la_carpeta_del_proyecto(self):
        os.symlink(self.outside, self.root / "enlace-dir")
        os.symlink(self.outside / "secreto.txt", self.root / "enlace-fichero")
        os.symlink(self.root / "README.md", self.root / "enlace-interno")
        escapes = ["..", "../fuera", str(self.outside), "src/../../fuera", "enlace-dir", "~", "enlace-fichero"]
        for path in escapes:
            for method in ("zerochat/files/list", "zerochat/files/read", "zerochat/files/download"):
                with self.subTest(path=path, method=method):
                    result, error = self.call(method, path=path)
                    self.assertIsNone(result)
                    self.assertEqual(error["code"], -32602)
        # Un enlace que se queda dentro del proyecto sí se puede abrir.
        inner, error = self.call("zerochat/files/read", path="enlace-interno")
        self.assertIsNone(error)
        self.assertEqual(inner["text"], "# Hola\n")

    def test_un_fichero_es_texto_salvo_byte_nulo_o_utf8_no_valido(self):
        (self.root / "dato.bin").write_bytes(b"PNG\0\x01\x02")
        (self.root / "latin1.txt").write_bytes("canción".encode("latin-1"))
        # Un carácter de varios bytes partido en el borde del comienzo examinado no lo hace binario.
        cut = "a" * (zerochat.TEXT_SNIFF_BYTES - 1) + "ñ" + "b"
        (self.root / "partido.txt").write_text(cut, encoding="utf-8", newline="\n")
        text, _ = self.call("zerochat/files/read", path="src/main.py")
        self.assertEqual((text["binary"], text["text"], text["path"]), (False, "print('hola')\n", "src/main.py"))
        for name, binary in (("dato.bin", True), ("latin1.txt", True), ("partido.txt", False)):
            with self.subTest(name=name):
                result, _ = self.call("zerochat/files/read", path=name)
                self.assertEqual(result["binary"], binary)
                self.assertEqual("text" in result, not binary)

    def test_un_texto_mayor_que_el_tope_de_la_vista_no_se_devuelve_y_se_descarga(self):
        (self.root / "grande.txt").write_text("a" * 10, encoding="utf-8", newline="\n")
        for limit, too_large in ((10, False), (9, True)):
            with self.subTest(limit=limit), patch.object(zerochat, "MAX_TEXT_VIEW_BYTES", limit):
                result, _ = self.call("zerochat/files/read", path="grande.txt")
                self.assertEqual((result.get("too_large", False), "text" in result), (too_large, not too_large))

    def test_la_descarga_por_paginas_reconstruye_el_fichero_y_respeta_su_tope(self):
        content = bytes(range(256)) * 5
        (self.root / "dato.bin").write_bytes(content)
        with patch.object(zerochat, "DOWNLOAD_PAGE_BYTES", 300):
            pieces, offset, done = [], 0, False
            while not done:
                page, error = self.call("zerochat/files/download", path="dato.bin", offset=offset)
                self.assertIsNone(error)
                pieces.append(base64.b64decode(page["data"]))
                offset, done = page["next"], page["done"]
            self.assertEqual((b"".join(pieces), page["name"], page["size"]), (content, "dato.bin", len(content)))
        for offset in (-1, len(content) + 1, True, "0"):
            with self.subTest(offset=offset):
                self.assertEqual(self.call("zerochat/files/download", path="dato.bin", offset=offset)[1]["code"], -32602)
        for limit, allowed in ((len(content), True), (len(content) - 1, False)):
            with self.subTest(limit=limit), patch.object(zerochat, "MAX_DOWNLOAD_BYTES", limit):
                result, error = self.call("zerochat/files/download", path="dato.bin")
                self.assertEqual(error is None, allowed)

    def test_el_runner_no_puede_usar_el_navegador_de_ficheros(self):
        grant = zerochat.TokenGrant(token="t", kind="runner", date="2026-11-14", created_at=0.0, run_id="r", conversation_id="c")
        for method in ("zerochat/files/list", "zerochat/files/read", "zerochat/files/download"):
            with self.subTest(method=method):
                self.assertFalse(grant.allows("/mcp", method, {}))


if __name__ == "__main__":
    unittest.main()
