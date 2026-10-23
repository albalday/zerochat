import json
import unittest

from backend import use_data_dir, zerochat


class ExternalSymlinkTest(unittest.TestCase):
    def setUp(self):
        base = use_data_dir(self)
        outside = base / "outside.txt"
        outside.write_text("SECRET_EXTERNAL_DATA", encoding="utf-8")
        self.project = base / "proj"
        self.project.mkdir()
        (self.project / "regular.txt").write_text("hello world\nregular line", encoding="utf-8")
        (self.project / "symlink_ext.txt").symlink_to(outside)
        sub = self.project / "sub"
        sub.mkdir()
        (sub / "inside.py").write_text("print('inside')\n", encoding="utf-8")
        (sub / "ext_link.py").symlink_to(outside)

    def test_list_directory_recursivo_lista_un_simbolico_externo_sin_fallar(self):
        result = json.loads(zerochat.list_directory(str(self.project), recursive=True))
        self.assertIs(result["success"], True)
        self.assertIn("symlink_ext.txt", [entry["name"] for entry in result["entries"]])

    def test_search_files_no_busca_en_simbolicos_externos(self):
        outside = json.loads(zerochat.search_files("SECRET_EXTERNAL", path=str(self.project)))
        self.assertIs(outside["success"], True)
        self.assertEqual(outside["total_matches"], 0)
        inside = json.loads(zerochat.search_files("hello", path=str(self.project)))
        self.assertEqual((inside["success"], inside["total_matches"]), (True, 1))
        self.assertNotIn("warning", inside)

    def test_search_files_avisa_cuando_una_regex_invalida_pasa_a_texto_literal(self):
        result = json.loads(zerochat.search_files("hello(", path=str(self.project)))
        self.assertIs(result["success"], True)
        self.assertIn("treated as literal text", result["warning"])

    def test_search_files_filtra_por_glob_y_acota_los_resultados(self):
        python_only = json.loads(zerochat.search_files("in", path=str(self.project), file_pattern="*.py"))
        self.assertEqual([match["relative_path"] for match in python_only["matches"]], ["sub/inside.py"])
        limited = json.loads(zerochat.search_files("l", path=str(self.project), max_results=1))
        self.assertEqual((len(limited["matches"]), limited["truncated"]), (1, True))

    def test_get_diagnostics_no_escanea_simbolicos_externos(self):
        result = json.loads(zerochat.get_diagnostics(path=str(self.project)))
        self.assertEqual((result["success"], result["error_count"]), (True, 0))


class ReadFileTest(unittest.TestCase):
    def test_read_file_devuelve_el_rango_de_lineas_pedido(self):
        text_file = use_data_dir(self) / "text.txt"
        text_file.write_text("uno\ndos\ntres\ncuatro\n", encoding="utf-8")
        result = json.loads(zerochat.read_file(str(text_file), start_line=2, end_line=3))
        self.assertEqual((result["lines_returned"], result["start_line"], result["end_line"]), (2, 2, 3))
        self.assertIn("dos", result["content"])
        self.assertNotIn("cuatro", result["content"])

    def test_read_file_devuelve_como_maximo_2000_lineas(self):
        big_file = use_data_dir(self) / "big.txt"
        big_file.write_text("\n".join(f"line_{i}" for i in range(1, 3000)), encoding="utf-8")
        for end_line in (2000, 2001):
            with self.subTest(end_line=end_line):
                result = json.loads(zerochat.read_file(str(big_file), start_line=1, end_line=end_line))
                self.assertIs(result["success"], True)
                self.assertEqual((result["lines_returned"], result["end_line"]), (2000, 2000))
                self.assertIs(result["truncated"], True)


class EditFileTest(unittest.TestCase):
    def setUp(self):
        self.path = use_data_dir(self) / "edit.txt"
        self.path.write_text("primera linea\nsegunda linea objetivo\ntercera linea\n", encoding="utf-8")

    def edit(self, old_str, new_str, **kwargs):
        return json.loads(zerochat.edit_file(str(self.path), old_str, new_str, **kwargs))

    def test_sustituye_un_texto_exacto_y_unico(self):
        self.assertEqual(self.edit("objetivo", "modificada")["replacements"], 1)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "primera linea\nsegunda linea modificada\ntercera linea\n")

    def test_varias_coincidencias_exigen_replace_all_que_las_sustituye_todas(self):
        ambiguous = self.edit("linea", "fila")
        self.assertIs(ambiguous["success"], False)
        self.assertRegex(ambiguous["error"], r"Found 3 matches[\s\S]*replace_all")
        self.assertEqual(self.edit("linea", "fila", replace_all=True)["replacements"], 3)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "primera fila\nsegunda fila objetivo\ntercera fila\n")

    def test_un_texto_ausente_o_vacio_es_un_error_y_no_cambia_el_fichero(self):
        before = self.path.read_text(encoding="utf-8")
        self.assertIn("Target text was not found", self.edit("inexistente", "x")["error"])
        # Un old_str vacío insertaría el texto entre cada carácter.
        self.assertIn("old_str is empty", self.edit("", "x", replace_all=True)["error"])
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)
