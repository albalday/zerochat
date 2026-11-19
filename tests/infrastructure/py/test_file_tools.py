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

    def test_simbolicos_externos_se_listan_pero_search_files_y_diagnostics_no_los_escanean(self):
        result = json.loads(zerochat.list_directory(str(self.project), recursive=True, ctx=CTX))
        self.assertIs(result["success"], True)
        self.assertIn("symlink_ext.txt", [entry["name"] for entry in result["entries"]])

        outside = json.loads(zerochat.search_files("SECRET_EXTERNAL", path=str(self.project), ctx=CTX))
        self.assertEqual((outside["success"], outside["total_matches"]), (True, 0))
        inside = json.loads(zerochat.search_files("hello", path=str(self.project), ctx=CTX))
        self.assertEqual((inside["success"], inside["total_matches"]), (True, 1))

        diag = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
        self.assertEqual((diag["success"], diag["error_count"]), (True, 0))

    def test_search_files_busca_textos_fijos_filtra_por_glob_y_acota_los_resultados(self):
        notes = self.project / "notes.md"
        notes.write_text("runner.js loads\nrunnerXjs is not a match\n(a+)+$ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\nM72 PLAN\n", encoding="utf-8")
        search = lambda query, path=notes: json.loads(zerochat.search_files(query, path=str(path), ctx=CTX))
        lines = lambda result: [match["line_number"] for match in result["matches"]]
        # Texto fijo: el punto no casa con cualquier carácter y un patrón catastrófico es solo texto.
        self.assertEqual(lines(search("runner.js")), [1])
        self.assertEqual(lines(search("(a+)+$")), [3])
        self.assertEqual(lines(search("m72| loads ")), [1, 4])
        self.assertEqual(search("m72", self.project)["matches"][0]["relative_path"], "notes.md")
        self.assertEqual(search(" | ")["success"], False)

        python_only = json.loads(zerochat.search_files("in", path=str(self.project), file_pattern="*.py", ctx=CTX))
        self.assertEqual([match["relative_path"] for match in python_only["matches"]], ["sub/inside.py"])
        limited = json.loads(zerochat.search_files("l", path=str(self.project), max_results=1, ctx=CTX))
        self.assertEqual((len(limited["matches"]), limited["truncated"]), (1, True))


class DiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.project = use_data_dir(self) / "proj"
        (self.project / "sub").mkdir(parents=True)
        (self.project / "ok.py").write_text("x = 1\n", encoding="utf-8")
        (self.project / "sub" / "bad.py").write_text("def f(:\n", encoding="utf-8")
        (self.project / "bad.json").write_text('{"a": }', encoding="utf-8")
        (self.project / ".hidden").mkdir()
        (self.project / ".hidden" / "bad.py").write_text("def f(:\n", encoding="utf-8")

    def test_senala_errores_de_python_y_json_sin_entrar_en_ocultas_y_acota_a_200_ficheros(self):
        result = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
        self.assertEqual(result["files_checked"], 3)
        self.assertEqual(sorted(diag["message"].split(":")[0] for diag in result["diagnostics"]), ["JSONDecodeError", "SyntaxError"])

        single = json.loads(zerochat.get_diagnostics(path=str(self.project / "sub" / "bad.py"), ctx=CTX))
        self.assertEqual((single["files_checked"], single["diagnostics"][0]["line"]), (1, 1))
        for index in range(210):
            (self.project / f"f{index:03}.json").write_text("{}", encoding="utf-8")
        self.assertEqual(json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))["files_checked"], 200)


class ReadFileTest(unittest.TestCase):
    def test_read_file_devuelve_el_rango_de_lineas_pedido_y_como_maximo_2000_lineas(self):
        text_file = use_data_dir(self) / "text.txt"
        text_file.write_text("uno\ndos\ntres\ncuatro\n", encoding="utf-8")
        result = json.loads(zerochat.read_file(str(text_file), start_line=2, end_line=3, ctx=CTX))
        self.assertEqual((result["lines_returned"], result["start_line"], result["end_line"]), (2, 2, 3))
        self.assertIn("dos", result["content"])
        self.assertNotIn("cuatro", result["content"])

        big_file = use_data_dir(self) / "big.txt"
        big_file.write_text("\n".join(f"line_{i}" for i in range(1, 3000)), encoding="utf-8")
        for end_line in (2000, 2001):
            with self.subTest(end_line=end_line):
                result = json.loads(zerochat.read_file(str(big_file), start_line=1, end_line=end_line, ctx=CTX))
                self.assertIs(result["success"], True)
                self.assertEqual((result["lines_returned"], result["end_line"]), (2000, 2000))
                self.assertIs(result["truncated"], True)

    def test_read_file_tail_lines_devuelve_el_final_limpio_y_sin_partir_lineas_entre_bloques(self):
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
        whole = json.loads(zerochat.read_file(str(log), tail_lines=50, ctx=CTX))
        self.assertEqual((whole["start_line"], whole["lines_returned"], whole["truncated"]), (1, 4, False))

        big = use_data_dir(self) / "big.log"
        big.write_text("".join(f"paso {i:06d} " + "x" * 90 + "\n" for i in range(1, 3001)), encoding="utf-8")
        result = json.loads(zerochat.read_file(str(big), tail_lines=2, ctx=CTX))
        self.assertEqual([line[:11] for line in result["content"].splitlines()], ["paso 002999", "paso 003000"])
        self.assertEqual((result["total_lines"], result["start_line"]), (3000, 2999))
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

    def test_sustituye_un_texto_unico_exige_replace_all_con_varios_y_rechaza_ausente_o_vacio(self):
        before = self.path.read_text(encoding="utf-8")
        self.assertIn("Target text was not found", self.edit("inexistente", "x")["error"])
        self.assertIn("old_str is empty", self.edit("", "x", replace_all=True)["error"])
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

        ambiguous = self.edit("linea", "fila")
        self.assertIs(ambiguous["success"], False)
        self.assertRegex(ambiguous["error"], r"Found 3 matches[\s\S]*replace_all")
        self.assertEqual(self.edit("objetivo", "modificada")["replacements"], 1)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "primera linea\nsegunda linea modificada\ntercera linea\n")
        self.assertEqual(self.edit("linea", "fila", replace_all=True)["replacements"], 3)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "primera fila\nsegunda fila modificada\ntercera fila\n")
