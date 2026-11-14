import json
import unittest
from pathlib import Path

from backend import use_data_dir, zerochat

# Las pruebas pasan rutas absolutas: el proyecto del contexto no interviene.
CTX = zerochat.SecurityContext(Path.cwd())


class SamePathForPermissionsAndExecutionTest(unittest.TestCase):
    def test_dotdot_after_a_symlink_is_collapsed_the_same_way_for_both(self):
        base = use_data_dir(self)
        project, outside = base / "proj", base / "outside"
        (project).mkdir()
        (outside / "deep").mkdir(parents=True)
        (project / "link").symlink_to(outside / "deep")
        ctx = zerochat.SecurityContext(project.resolve())
        # 'link/../x' es '<proyecto>/x' (lo que ven los permisos), no la carpeta superior del destino del enlace
        self.assertEqual(ctx.absolute("link/../x"), project.resolve() / "x")
        self.assertEqual(ctx.resolve_path("link/../x"), ctx.absolute("link/../x"))
        with self.assertRaises(ValueError):
            ctx.absolute("../../../../../../../../..")
        self.assertIsNone(ctx.resolve_path("~/x"), "Los permisos no aceptan '~'")
        self.assertEqual(ctx.absolute("~/x"), Path("~/x").expanduser().resolve(), "La herramienta, tras aprobarlo, sí")


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
        result = json.loads(zerochat.list_directory(str(self.project), recursive=True, ctx=CTX))
        self.assertIs(result["success"], True)
        self.assertIn("symlink_ext.txt", [entry["name"] for entry in result["entries"]])

    def test_search_files_no_busca_en_simbolicos_externos(self):
        outside = json.loads(zerochat.search_files("SECRET_EXTERNAL", path=str(self.project), ctx=CTX))
        self.assertIs(outside["success"], True)
        self.assertEqual(outside["total_matches"], 0)
        inside = json.loads(zerochat.search_files("hello", path=str(self.project), ctx=CTX))
        self.assertEqual((inside["success"], inside["total_matches"]), (True, 1))
        self.assertNotIn("warning", inside)

    def test_search_files_avisa_cuando_una_regex_invalida_pasa_a_texto_literal(self):
        result = json.loads(zerochat.search_files("hello(", path=str(self.project), ctx=CTX))
        self.assertIs(result["success"], True)
        self.assertIn("treated as literal text", result["warning"])

    def test_search_files_filtra_por_glob_y_acota_los_resultados(self):
        python_only = json.loads(zerochat.search_files("in", path=str(self.project), file_pattern="*.py", ctx=CTX))
        self.assertEqual([match["relative_path"] for match in python_only["matches"]], ["sub/inside.py"])
        limited = json.loads(zerochat.search_files("l", path=str(self.project), max_results=1, ctx=CTX))
        self.assertEqual((len(limited["matches"]), limited["truncated"]), (1, True))

    def test_get_diagnostics_no_escanea_simbolicos_externos(self):
        result = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
        self.assertEqual((result["success"], result["error_count"]), (True, 0))


class ReadFileTest(unittest.TestCase):
    def test_read_file_devuelve_el_rango_de_lineas_pedido(self):
        text_file = use_data_dir(self) / "text.txt"
        text_file.write_text("uno\ndos\ntres\ncuatro\n", encoding="utf-8")
        result = json.loads(zerochat.read_file(str(text_file), start_line=2, end_line=3, ctx=CTX))
        self.assertEqual((result["lines_returned"], result["start_line"], result["end_line"]), (2, 2, 3))
        self.assertIn("dos", result["content"])
        self.assertNotIn("cuatro", result["content"])

    def test_read_file_devuelve_como_maximo_2000_lineas(self):
        big_file = use_data_dir(self) / "big.txt"
        big_file.write_text("\n".join(f"line_{i}" for i in range(1, 3000)), encoding="utf-8")
        for end_line in (2000, 2001):
            with self.subTest(end_line=end_line):
                result = json.loads(zerochat.read_file(str(big_file), start_line=1, end_line=end_line, ctx=CTX))
                self.assertIs(result["success"], True)
                self.assertEqual((result["lines_returned"], result["end_line"]), (2000, 2000))
                self.assertIs(result["truncated"], True)


    def test_read_file_tail_lines_devuelve_el_final_limpio_de_un_log_vivo(self):
        log = use_data_dir(self) / "comfyui.log"
        log.write_bytes(
            b"\x1b[32m[INFO]\x1b[0m arrancando\n"
            b"\x1b[32m[INFO]\x1b[0m got prompt\n"
            b"  5%|5         | 1/20\r 10%|1         | 2/20\r\n"
            b"\x1b[31m[ERROR]\x1b[0m out of memory"
        )
        result = json.loads(zerochat.read_file(str(log), tail_lines=3, ctx=CTX))
        self.assertEqual(result["content"], "[INFO] got prompt\n 10%|1         | 2/20\n[ERROR] out of memory")
        self.assertEqual((result["total_lines"], result["start_line"], result["end_line"], result["lines_returned"], result["truncated"]),
                         (4, 2, 4, 3, True))
        # Más líneas de las que tiene: todo, sin truncar.
        whole = json.loads(zerochat.read_file(str(log), tail_lines=50, ctx=CTX))
        self.assertEqual((whole["start_line"], whole["lines_returned"], whole["truncated"]), (1, 4, False))

    def test_read_file_tail_lines_lee_desde_el_final_sin_partir_lineas_entre_bloques(self):
        big = use_data_dir(self) / "big.log"
        # Más de un bloque de lectura: las líneas pedidas cruzan la frontera de bloque.
        big.write_text("".join(f"paso {i:06d} " + "x" * 90 + "\n" for i in range(1, 3001)), encoding="utf-8")
        result = json.loads(zerochat.read_file(str(big), tail_lines=2, ctx=CTX))
        self.assertEqual([line[:11] for line in result["content"].splitlines()], ["paso 002999", "paso 003000"])
        self.assertEqual((result["total_lines"], result["start_line"]), (3000, 2999))
        # El tope de bytes manda sobre las líneas pedidas, y nunca se devuelve una línea a medias.
        capped = json.loads(zerochat.read_file(str(big), tail_lines=2000, max_bytes=1024, ctx=CTX))
        self.assertTrue(all(line.startswith("paso ") for line in capped["content"].splitlines()))
        self.assertLess(capped["lines_returned"], 11)
        self.assertEqual(capped["end_line"], 3000)


class EditFileTest(unittest.TestCase):
    def setUp(self):
        self.path = use_data_dir(self) / "edit.txt"
        self.path.write_text("primera linea\nsegunda linea objetivo\ntercera linea\n", encoding="utf-8")

    def edit(self, old_str, new_str, **kwargs):
        return json.loads(zerochat.edit_file(str(self.path), old_str, new_str, **kwargs, ctx=CTX))

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
