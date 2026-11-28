import json
import os
import stat
import unittest
from pathlib import Path
from unittest.mock import patch

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
        self.assertEqual(ctx.absolute("../outside_file"), project.resolve().parent / "outside_file")
        self.assertEqual(ctx.resolve_path("../outside_file"), ctx.absolute("../outside_file"))
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
        # Exactamente max_results coincidencias no es truncar; una más, sí.
        for limit, truncated in ((2, False), (1, True)):
            exact = json.loads(zerochat.search_files("m72| loads ", path=str(notes), max_results=limit, ctx=CTX))
            self.assertEqual((len(exact["matches"]), exact["truncated"]), (limit, truncated))

    def test_list_directory_avisa_del_tope_de_entradas_en_el_borde_exacto(self):
        listing = lambda: json.loads(zerochat.list_directory(str(self.project), ctx=CTX))
        count = len(listing()["entries"])
        for limit, truncated in ((count, False), (count - 1, True)):
            with self.subTest(limit=limit), patch.object(zerochat, "LIST_DIRECTORY_MAX_ENTRIES", limit):
                result = listing()
                self.assertEqual((result["total_items"], result["truncated"]), (limit, truncated))


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
        self.assertIs(result["truncated"], False)
        # Borde del tope: 200 ficheros comprobables caben sin aviso; 201 avisan.
        limit = zerochat.DIAGNOSTICS_MAX_FILES
        for index in range(limit - 3):
            (self.project / f"f{index:03}.json").write_text("{}", encoding="utf-8")
        for extra, truncated in ((0, False), (1, True)):
            if extra:
                (self.project / "extra.json").write_text("{}", encoding="utf-8")
            full = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
            self.assertEqual((full["files_checked"], full["truncated"]), (limit, truncated))

    def test_un_fichero_que_desaparece_o_no_se_puede_leer_no_rompe_el_resto(self):
        # Un enlace roto dentro del proyecto: os.walk lo lista, pero stat() falla como si lo hubieran borrado.
        (self.project / "roto.py").symlink_to(self.project / "no-existe.py")
        result = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
        self.assertIs(result["success"], True, result)
        self.assertEqual((result["files_checked"], result["error_count"]), (3, 2))

    def test_los_ficheros_por_encima_del_tope_de_bytes_se_listan_sin_comprobar(self):
        limit = 64
        big = self.project / "big.json"
        with patch.object(zerochat, "DIAGNOSTICS_MAX_FILE_BYTES", limit):
            for size, skipped in ((limit, []), (limit + 1, ["big.json"])):
                # En bytes: write_text pondría \r\n en Windows y el fichero tendría un byte más.
                big.write_bytes(("[" + " " * (size - 3) + "]\n").encode())
                result = json.loads(zerochat.get_diagnostics(path=str(self.project), ctx=CTX))
                self.assertEqual((result["files_checked"], [Path(p).name for p in result["skipped_too_large"]]), (4 - len(skipped), skipped), size)


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

    def test_tail_lines_de_una_sola_linea_mayor_que_max_bytes_devuelve_su_final(self):
        base = use_data_dir(self)
        # Un minificado sin saltos de línea, con un carácter de dos bytes justo donde corta max_bytes.
        minified = base / "app.min.js"
        minified.write_bytes(("é" + "x" * 1023 + "FIN").encode("utf-8"))
        result = json.loads(zerochat.read_file(str(minified), tail_lines=5, max_bytes=1025, ctx=CTX))
        self.assertEqual(result["content"], "x" * 1022 + "FIN")
        self.assertEqual((result["total_lines"], result["start_line"], result["lines_returned"], result["truncated"]),
                         (1, 1, 1, True))
        # Con su salto final y precedida de otra línea, igual: lo que no cabe se recorta por el principio.
        minified.write_bytes(b"cabecera\n" + b"y" * 5000 + b"FIN\n")
        result = json.loads(zerochat.read_file(str(minified), tail_lines=5, max_bytes=1024, ctx=CTX))
        self.assertEqual(result["content"], "y" * 1020 + "FIN\n")
        self.assertEqual((result["start_line"], result["lines_returned"], result["truncated"]), (2, 1, True))
        # Si cabe entera, sale entera y sin aviso de recorte.
        minified.write_bytes(b"z" * 1021 + b"FIN")
        result = json.loads(zerochat.read_file(str(minified), tail_lines=5, max_bytes=1024, ctx=CTX))
        self.assertEqual((result["content"], result["truncated"]), ("z" * 1021 + "FIN", False))

    def test_read_file_no_carga_entera_una_linea_enorme(self):
        import tracemalloc
        huge = use_data_dir(self) / "volcado.txt"
        size = 8 * 1024 * 1024
        with open(huge, "wb") as handle:
            handle.write(b"a" * size + b"\nsegunda\n")
        tracemalloc.start()
        try:
            first = json.loads(zerochat.read_file(str(huge), max_bytes=1024, ctx=CTX))
            second = json.loads(zerochat.read_file(str(huge), start_line=2, ctx=CTX))
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual((first["content"], first["truncated"]), ("a" * 1024, True))
        self.assertEqual((second["content"], second["start_line"], second["total_lines"]), ("segunda\n", 2, 2))
        self.assertLess(peak, size // 4, "La línea de 8 MiB no debe estar entera en memoria")

    def test_read_file_lee_imagenes_raster_en_base64_y_acota_en_n_y_n_mas_1(self):
        img_dir = use_data_dir(self)
        png = img_dir / "teclado.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n1234")
        res = json.loads(zerochat.read_file(str(png), ctx=CTX))
        self.assertTrue(res["success"])
        self.assertEqual((res["mime_type"], res["size_bytes"]), ("image/png", 12))
        self.assertTrue(res["image_base64"])

        empty = img_dir / "vacia.jpg"
        empty.write_bytes(b"")
        self.assertFalse(json.loads(zerochat.read_file(str(empty), ctx=CTX))["success"])

        limit = zerochat.READ_FILE_IMAGE_MAX_BYTES
        at_limit = img_dir / "borde.webp"
        at_limit.write_bytes(b"A" * limit)
        self.assertTrue(json.loads(zerochat.read_file(str(at_limit), ctx=CTX))["success"])
        at_limit.write_bytes(b"A" * (limit + 1))
        over = json.loads(zerochat.read_file(str(at_limit), ctx=CTX))
        self.assertFalse(over["success"])
        self.assertIn(str(limit), over["error"])


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

    def test_rechaza_editar_por_encima_del_tope_de_bytes_sin_tocar_el_fichero(self):
        limit = 64
        with patch.object(zerochat, "EDIT_FILE_MAX_BYTES", limit):
            self.path.write_text("objetivo" + "x" * (limit - 8), encoding="utf-8")
            self.assertEqual(self.edit("objetivo", "hecho")["replacements"], 1)
            self.path.write_text("objetivo" + "x" * (limit - 7), encoding="utf-8")
            self.assertIn("over the 64-byte limit", self.edit("objetivo", "hecho")["error"])
            self.assertTrue(self.path.read_text(encoding="utf-8").startswith("objetivo"))

    @unittest.skipIf(os.name == "nt", "permisos POSIX")
    def test_la_escritura_conserva_los_permisos_y_no_deja_temporales_si_falla(self):
        self.path.chmod(0o750)
        self.assertEqual(self.edit("objetivo", "x")["replacements"], 1)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o750)
        with patch.object(zerochat.Path, "replace", side_effect=OSError("disco lleno")), self.assertRaises(OSError):
            zerochat._atomic_write_text(self.path, "nuevo")
        self.assertEqual([p.name for p in self.path.parent.iterdir() if ".tmp_" in p.name], [])
