#!/usr/bin/env python3
"""
Bundler HTML autónomo con compresión Gzip/Base64.

Parte de un documento HTML y detecta, en el mismo orden en que aparecen, sus hojas
de estilo y scripts locales. Los incorpora en un único HTML portable sin depender de
la estructura ni del nombre de un proyecto concreto.

Características principales:
- Concatena todos los archivos JavaScript (.js) en un único cuerpo de código.
- Elimina comentarios (bloque y línea) de forma segura con un tokenizador FSM en Python puro,
  sin manipular ni alterar identificadores ni lógica AST previa.
- Comprime el JavaScript unificado utilizando la biblioteca estándar 'gzip' de Python
  al máximo nivel de compresión (compresslevel=9).
- Convierte los bytes comprimidos a Base64 y los inyecta en una etiqueta:
    <script type="application/gzip-base64" id="compressed-js">
- Incluye un cargador bootstrap nativo que descomprime el payload con DecompressionStream('gzip')
  en tiempo de ejecución en el navegador.
- Minificación integral de HTML estructural y estilos CSS.
- Verificación automática de integridad, descompresión y validación sintáctica post-build.
"""

import argparse
import base64
import gzip
import json
import os
import re
import subprocess
import sys
import time
from typing import Dict, List, Optional, Tuple
from urllib.parse import unquote, urlsplit

BOOTSTRAP_LOADER_SCRIPT = """<script>
(async () => {
  try {
    const decompress = async (id) => {
      const el = document.getElementById(id);
      if (!el) return '';
      const b64 = el.textContent.trim();
      if (!b64) return '';
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes], { type: 'application/gzip' }).stream().pipeThrough(ds);
      return await new Response(stream).text();
    };

    const [cssCode, jsCode] = await Promise.all([
      decompress('compressed-css'),
      decompress('compressed-js')
    ]);

    if (cssCode) {
      const style = document.createElement('style');
      style.id = 'zerochat-bundled-styles';
      style.textContent = cssCode;
      document.head.appendChild(style);
    }
    document.documentElement.classList.add('zerochat-ready');

    if (jsCode) {
      const script = document.createElement('script');
      script.id = 'zerochat-bundled-script';
      script.textContent = jsCode;
      document.body.appendChild(script);
    }
  } catch (err) {
    document.documentElement.classList.add('zerochat-ready');
    console.error('Error al inicializar ZeroChat comprimido:', err);
  }
})();
</script>"""


LOCAL_STYLESHEET_RE = re.compile(
    r'<link\b(?=[^>]*\brel=["\'][^"\']*\bstylesheet\b[^"\']*["\'])[^>]*>',
    re.IGNORECASE,
)
SCRIPT_SRC_RE = re.compile(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script\s*>', re.IGNORECASE)
HREF_RE = re.compile(r'\bhref=["\']([^"\']+)["\']', re.IGNORECASE)
CSS_IMPORT_RE = re.compile(
    r'@import\s+(?:url\(\s*)?["\']([^"\')]+)["\']\s*\)?\s*([^;]*);', re.IGNORECASE
)


def local_resource_path(document_dir: str, reference: str) -> str | None:
    """Devuelve la ruta de un recurso local relativo o ``None`` para URL externas."""
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or reference.startswith("/"):
        return None
    path = unquote(parsed.path)
    if not path:
        return None
    return os.path.normpath(os.path.join(document_dir, path))


def read_referenced_resources(
    html: str,
    document_dir: str,
    pattern: re.Pattern[str],
    attribute_pattern: re.Pattern[str],
    resource_kind: str,
) -> Tuple[List[str], List[str]]:
    """Lee recursos locales referenciados por etiquetas HTML, preservando su orden."""
    contents: List[str] = []
    missing: List[str] = []
    for tag_match in pattern.finditer(html):
        attribute_match = attribute_pattern.search(tag_match.group(0))
        if not attribute_match:
            continue
        reference = attribute_match.group(1)
        resource_path = local_resource_path(document_dir, reference)
        if resource_path is None:
            continue
        if not os.path.isfile(resource_path):
            missing.append(reference)
            continue
        with open(resource_path, "r", encoding="utf-8") as resource_file:
            contents.append(resource_file.read())
    if missing:
        raise FileNotFoundError(
            f"Faltan {resource_kind} locales referenciados por el HTML: {', '.join(missing)}"
        )
    return contents, [
        match.group(0)
        for match in pattern.finditer(html)
        if (attribute_match := attribute_pattern.search(match.group(0)))
        and local_resource_path(document_dir, attribute_match.group(1)) is not None
    ]


def read_css_with_imports(css_path: str, import_stack: Tuple[str, ...] = ()) -> str:
    """Expande ``@import`` locales para que el CSS también sea autónomo."""
    normalized_path = os.path.normpath(css_path)
    if normalized_path in import_stack:
        chain = " -> ".join((*import_stack, normalized_path))
        raise ValueError(f"Importación CSS circular: {chain}")

    with open(normalized_path, "r", encoding="utf-8") as css_file:
        css = css_file.read()
    css_dir = os.path.dirname(normalized_path)

    def replace_import(match: re.Match[str]) -> str:
        imported_path = local_resource_path(css_dir, match.group(1))
        if imported_path is None:
            return match.group(0)
        if not os.path.isfile(imported_path):
            raise FileNotFoundError(f"Hoja de estilo importada no encontrada: {match.group(1)}")
        imported_css = read_css_with_imports(imported_path, (*import_stack, normalized_path))
        media_query = match.group(2).strip()
        return f"@media {media_query}{{{imported_css}}}" if media_query else imported_css

    return CSS_IMPORT_RE.sub(replace_import, css)


def read_project_version(document_dir: str, raw_html: str = "") -> str:
    """Lee la versión declarada del proyecto (package.json o título de index.html)."""
    package_path = os.path.join(document_dir, "package.json")
    try:
        with open(package_path, "r", encoding="utf-8") as f:
            version = json.load(f).get("version")
        if isinstance(version, str) and version.strip():
            return version.strip()
    except (OSError, json.JSONDecodeError, AttributeError):
        pass

    # Intentar extraer desde la etiqueta <title>ZeroChat X.Y.Z</title>
    if raw_html:
        m = re.search(r'<title>\s*ZeroChat\s+v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*</title>', raw_html, re.IGNORECASE)
        if m:
            return m.group(1).strip()

    return "dev"


def minify_html(html: str, mode: str = "prod") -> str:
    """
    Minifica el marcado HTML preservando bloques de texto sensible (<pre>, <textarea>, <code>).
    """
    if mode == "dev":
        return html

    preserved_blocks: Dict[str, str] = {}

    def save_block(match: re.Match) -> str:
        key = f"___PRESERVED_HTML_BLOCK_{len(preserved_blocks)}___"
        preserved_blocks[key] = match.group(0)
        return key

    # 1. Preservar bloques pre, textarea y code
    processed = re.sub(
        r'<(pre|textarea|code)[^>]*>[\s\S]*?</\1>',
        save_block,
        html,
        flags=re.IGNORECASE
    )

    # 2. Eliminar comentarios HTML (excepto condicionales IE)
    processed = re.sub(r'<!--(?!\s*\[if)[\s\S]*?-->', '', processed)

    # 3. Colapsar espacios y saltos de línea entre etiquetas contiguas
    processed = re.sub(r'>\s+<', '><', processed)

    # 4. Colapsar múltiples espacios consecutivos a uno solo
    processed = re.sub(r'[ \t\r\n]{2,}', ' ', processed)

    # 5. Restaurar bloques intactos
    for placeholder, original in preserved_blocks.items():
        processed = processed.replace(placeholder, original)

    return processed.strip()


def minify_css_external(css: str) -> Optional[str]:
    """
    Intenta minificar CSS utilizando esbuild si está disponible en el entorno.
    """
    try:
        res = subprocess.run(
            ['npx', '--no-install', 'esbuild', '--minify', '--loader=css'],
            input=css,
            capture_output=True,
            text=True,
            check=True
        )
        if res.stdout and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def minify_js_external(js: str) -> Optional[str]:
    """
    Intenta minificar JavaScript utilizando esbuild si está disponible en el entorno.
    """
    try:
        res = subprocess.run(
            ['npx', '--no-install', 'esbuild', '--minify', '--target=es2022'],
            input=js,
            capture_output=True,
            text=True,
            check=True
        )
        if res.stdout and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def minify_css_fallback(css: str) -> str:
    """
    Minificador CSS seguro en Python puro.
    Optimiza comentarios, espacios, ceros innecesarios y colores hexadecimales.
    """
    css_clean = re.sub(r'/\*[\s\S]*?\*/', '', css)
    css_clean = re.sub(r'\s+', ' ', css_clean)
    css_clean = re.sub(r'\s*([{}:;,>+~])\s*', r'\1', css_clean)
    css_clean = re.sub(r';\}', '}', css_clean)
    css_clean = re.sub(r'(?<![\d\w%])0(?:px|em|rem|pt|in|cm|mm)', '0', css_clean)
    css_clean = re.sub(r'#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3(?![0-9a-fA-F])', r'#\1\2\3', css_clean)
    return css_clean.strip()


def strip_js_comments(js: str) -> str:
    """
    Tokenizador léxico de JavaScript basado en máquina de estados finitos (FSM) en Python puro.
    Elimina exclusivamente comentarios (// y /* */) y líneas vacías sin alterar identificadores,
    cadenas ni lógica previa:
      - Cadenas con comillas simples ('...') o dobles ("...")
      - Template Literals (`...`) incluyendo expresiones anidadas ${...}
      - Expresiones Regulares literales (/.../flags)
      - Operadores de división (a / b)
      - Reglas de Automatic Semicolon Insertion (ASI)
    """
    output: List[str] = []
    i = 0
    n = len(js)
    stack: List[str] = []

    REGEX_PRECEDING_WORDS = {
        'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete',
        'void', 'throw', 'yield', 'else', 'do', 'new'
    }
    REGEX_PRECEDING_CHARS = set('({[=,:;!&|?+-*%/^~<>')

    last_non_space = ''
    last_word = ''

    while i < n:
        c = js[i]

        # 1. Cadena de comilla simple ('...')
        if c == "'":
            start = i
            i += 1
            while i < n and js[i] != "'":
                if js[i] == '\\':
                    i += 2
                elif js[i] == '\n':
                    break
                else:
                    i += 1
            i += 1
            output.append(js[start:i])
            last_non_space = "'"
            last_word = ''
            continue

        # 2. Cadena de comilla doble ("...")
        if c == '"':
            start = i
            i += 1
            while i < n and js[i] != '"':
                if js[i] == '\\':
                    i += 2
                elif js[i] == '\n':
                    break
                else:
                    i += 1
            i += 1
            output.append(js[start:i])
            last_non_space = '"'
            last_word = ''
            continue

        # 3. Template Literals (`...`)
        if c == '`':
            start = i
            i += 1
            stack.append('TEMPLATE_LITERAL')
            while i < n and stack and stack[-1] == 'TEMPLATE_LITERAL':
                if js[i] == '\\':
                    i += 2
                elif js[i] == '`':
                    stack.pop()
                    i += 1
                    break
                elif js[i] == '$' and i + 1 < n and js[i+1] == '{':
                    i += 2
                    stack.append('TEMPLATE_EXPR')
                    output.append(js[start:i])
                    start = i
                    break
                else:
                    i += 1
            if not stack or stack[-1] != 'TEMPLATE_EXPR':
                output.append(js[start:i])
            last_non_space = '`'
            last_word = ''
            continue

        # Salida o anidamiento de expresiones dentro de Template Literals
        if c == '}' and stack:
            if stack[-1] == 'TEMPLATE_EXPR':
                stack.pop()
                output.append('}')
                i += 1
                start = i
                while i < n and stack and stack[-1] == 'TEMPLATE_LITERAL':
                    if js[i] == '\\':
                        i += 2
                    elif js[i] == '`':
                        stack.pop()
                        i += 1
                        break
                    elif js[i] == '$' and i + 1 < n and js[i+1] == '{':
                        i += 2
                        stack.append('TEMPLATE_EXPR')
                        break
                    else:
                        i += 1
                output.append(js[start:i])
                last_non_space = '`' if (not stack or stack[-1] != 'TEMPLATE_EXPR') else '}'
                last_word = ''
                continue
            elif stack[-1] == 'BRACE':
                stack.pop()
                output.append('}')
                i += 1
                last_non_space = '}'
                last_word = ''
                continue

        if c == '{':
            if stack and stack[-1] == 'TEMPLATE_EXPR':
                stack.append('BRACE')
            output.append('{')
            i += 1
            last_non_space = '{'
            last_word = ''
            continue

        # 4. Comentario de una línea (// ...)
        if c == '/' and i + 1 < n and js[i+1] == '/':
            i += 2
            while i < n and js[i] != '\n':
                i += 1
            output.append('\n')  # Preservar salto de línea para ASI
            last_non_space = '\n'
            last_word = ''
            continue

        # 5. Comentario de bloque (/* ... */)
        if c == '/' and i + 1 < n and js[i+1] == '*':
            i += 2
            while i + 1 < n and not (js[i] == '*' and js[i+1] == '/'):
                i += 1
            i += 2
            output.append(' ')  # Espacio para evitar fusionar identificadores contiguos
            continue

        # 6. Expresión Regular Literal vs Operador de División
        if c == '/':
            is_regex = False
            if not last_non_space or last_non_space in REGEX_PRECEDING_CHARS:
                is_regex = True
            elif last_word in REGEX_PRECEDING_WORDS:
                is_regex = True

            if is_regex:
                start = i
                i += 1
                in_char_class = False
                while i < n:
                    if js[i] == '\\':
                        i += 2
                    elif js[i] == '[':
                        in_char_class = True
                        i += 1
                    elif js[i] == ']' and in_char_class:
                        in_char_class = False
                        i += 1
                    elif js[i] == '/' and not in_char_class:
                        i += 1
                        break
                    elif js[i] == '\n':
                        break
                    else:
                        i += 1
                while i < n and js[i].isalnum():
                    i += 1
                output.append(js[start:i])
                last_non_space = '/'
                last_word = ''
                continue
            else:
                output.append('/')
                i += 1
                last_non_space = '/'
                last_word = ''
                continue

        # 7. Caracteres generales
        output.append(c)
        if not c.isspace():
            last_non_space = c
            if c.isalnum() or c in '_$':
                last_word += c
            else:
                last_word = ''
        else:
            if c == '\n':
                last_non_space = '\n'
            last_word = ''
        i += 1

    code = ''.join(output)

    # Colapsar líneas vacías múltiples respetando los saltos necesarios
    lines = code.split('\n')
    cleaned_lines: List[str] = []
    for line in lines:
        if line.strip():
            cleaned_lines.append(line)
        elif cleaned_lines and cleaned_lines[-1] != '':
            cleaned_lines.append('')

    return '\n'.join(cleaned_lines)


def compress_to_gzip_base64(text: str) -> Tuple[str, int, int]:
    """
    Comprime texto usando la biblioteca estándar gzip con el nivel máximo (9)
    y lo codifica en Base64.
    Retorna (base64_string, bytes_gzip, bytes_base64).
    """
    raw_bytes = text.encode("utf-8")
    compressed_bytes = gzip.compress(raw_bytes, compresslevel=9)
    b64_string = base64.b64encode(compressed_bytes).decode("ascii")
    return b64_string, len(compressed_bytes), len(b64_string.encode("ascii"))


def compress_js_to_gzip_base64(js_code: str) -> Tuple[str, int, int]:
    """Alias de compatibilidad para compress_to_gzip_base64."""
    return compress_to_gzip_base64(js_code)


def verify_bundle(html_content: str, verbose: bool = False) -> Tuple[bool, List[str]]:
    """
    Verifica la integridad del archivo distribuible generado:
    1. Estructura HTML básica.
    2. Ausencia de referencias locales a CSS y JavaScript que debían incorporarse.
    3. Presencia de los payloads comprimidos CSS y JS.
    4. Descompresión gzip/Base64.
    5. Validación de sintaxis JavaScript embebido con Node.js.
    """
    errors: List[str] = []

    # 1. Estructura HTML básica
    required_tags = ['<!DOCTYPE html>', '<html', '<head', '</head>', '<body', '</body>', '</html>']
    for tag in required_tags:
        if tag.lower() not in html_content.lower():
            errors.append(f"Falta la etiqueta requerida '{tag}' en el documento generado.")

    # 2. Extraer y verificar CSS desde gzip Base64
    css_match = re.search(
        r'<script[^>]*type=["\']application/gzip-base64["\'][^>]*id=["\']compressed-css["\'][^>]*>(.*?)</script>',
        html_content,
        re.DOTALL | re.IGNORECASE
    )
    if css_match:
        try:
            b64_css = css_match.group(1).strip()
            gzip_bytes_css = base64.b64decode(b64_css)
            decompressed_css = gzip.decompress(gzip_bytes_css).decode("utf-8")
            if not decompressed_css.strip():
                errors.append("El CSS descomprimido está vacío.")
        except Exception as e:
            errors.append(f"Error al decodificar o descomprimir el payload CSS gzip Base64: {e}")

    # 3. Extraer el código JavaScript desde gzip Base64
    decompressed_js = ""
    compressed_match = re.search(
        r'<script[^>]*type=["\']application/gzip-base64["\'][^>]*id=["\']compressed-js["\'][^>]*>(.*?)</script>',
        html_content,
        re.DOTALL | re.IGNORECASE
    )

    if compressed_match:
        try:
            b64_payload = compressed_match.group(1).strip()
            gzip_bytes = base64.b64decode(b64_payload)
            decompressed_js = gzip.decompress(gzip_bytes).decode("utf-8")
        except Exception as e:
            errors.append(f"Error al decodificar o descomprimir el payload gzip Base64: {e}")
    else:
        errors.append("No se encontró el payload JavaScript embebido (<script id=\"compressed-js\">) en el HTML final.")

    # 4. Validar sintaxis JavaScript embebido con Node.js si está disponible
    if decompressed_js:
        try:
            val_res = subprocess.run(
                ['node', '-c'],
                input=decompressed_js,
                capture_output=True,
                text=True
            )
            if val_res.returncode != 0:
                errors.append(f"Error de sintaxis detectado en el JavaScript embebido: {val_res.stderr.strip()}")
            elif verbose:
                print("   ✅ Validación sintáctica con Node.js: Correcta y sin errores.")
        except FileNotFoundError:
            pass

    return len(errors) == 0, errors


def build_standalone_html(input_file: str, output_file: str, mode: str = "prod", force_fallback: bool = False, verbose: bool = False) -> bool:
    """
    Ejecuta el pipeline completo de compilación, compresión Gzip Base64 y generación del bundle autónomo.
    """
    start_time = time.time()
    input_path = os.path.abspath(input_file)
    document_dir = os.path.dirname(input_path)
    output_path = os.path.abspath(output_file)

    if not os.path.isfile(input_path):
        print(f"❌ Error: Archivo HTML base no encontrado: {input_path}", file=sys.stderr)
        return False

    # 1. Cargar HTML
    with open(input_path, "r", encoding="utf-8") as f:
        raw_html = f.read()
    raw_html_size = len(raw_html.encode("utf-8"))

    # 2. Cargar CSS local según el orden de las etiquetas <link> del HTML base.
    try:
        _, css_tags = read_referenced_resources(
            raw_html, document_dir, LOCAL_STYLESHEET_RE, HREF_RE, "hojas de estilo"
        )
        js_parts, js_tags = read_referenced_resources(
            raw_html, document_dir, SCRIPT_SRC_RE, SCRIPT_SRC_RE, "scripts"
        )
        css_parts = [
            read_css_with_imports(local_resource_path(document_dir, HREF_RE.search(tag).group(1)))
            for tag in css_tags
        ]
    except (OSError, UnicodeDecodeError, ValueError) as error:
        print(f"❌ Error al leer recursos del HTML base: {error}", file=sys.stderr)
        return False

    raw_css = "\n\n".join(css_parts)
    raw_css_size = len(raw_css.encode("utf-8"))

    css_engine = "Python Fallback"
    if mode == "dev":
        css_min = raw_css
        css_engine = "Unminified (Dev)"
    elif not force_fallback:
        css_ext = minify_css_external(raw_css)
        if css_ext is not None:
            css_min = css_ext
            css_engine = "esbuild CSS"
        else:
            css_min = minify_css_fallback(raw_css)
    else:
        css_min = minify_css_fallback(raw_css)

    min_css_size = len(css_min.encode("utf-8"))

    # 3. Concatenar scripts locales antes de comprimirlos para mejorar el ratio.
    project_version = read_project_version(document_dir, raw_html)
    version_bootstrap = f"globalThis.__ZEROCHAT_VERSION__ = {json.dumps(project_version)};\n"
    concatenated_js = version_bootstrap + ";\n".join(js_parts)
    raw_js_size = len(concatenated_js.encode("utf-8"))

    # 4. Eliminar comentarios y optimizar JavaScript
    clean_js = strip_js_comments(concatenated_js)
    clean_js_size = len(clean_js.encode("utf-8"))

    js_engine = "Python FSM"
    if mode == "dev":
        final_js = concatenated_js
        js_engine = "Unminified (Dev)"
    elif not force_fallback:
        js_ext = minify_js_external(clean_js)
        if js_ext is not None:
            final_js = js_ext
            js_engine = "esbuild JS"
        else:
            final_js = clean_js
    else:
        final_js = clean_js

    final_js_size = len(final_js.encode("utf-8"))

    # 5. Comprimir con Gzip level 9 y convertir a Base64
    b64_css, css_gzip_bytes, css_b64_bytes = compress_to_gzip_base64(css_min)
    b64_js, js_gzip_bytes, js_b64_bytes = compress_to_gzip_base64(final_js)

    # 6. Limpiar e integrar en HTML
    html_cleaned = raw_html
    for tag in css_tags + js_tags:
        html_cleaned = html_cleaned.replace(tag, '', 1)

    min_html_base = minify_html(html_cleaned, mode=mode)
    min_html_size = len(min_html_base.encode("utf-8"))

    critical_css = '<style>html{visibility:hidden}html.zerochat-ready{visibility:visible}</style>'
    compressed_css_tag = f'<script type="application/gzip-base64" id="compressed-css">{b64_css}</script>'
    compressed_js_tag = f'<script type="application/gzip-base64" id="compressed-js">{b64_js}</script>'
    
    final_html = min_html_base.replace("</head>", f"{critical_css}</head>")
    final_html = final_html.replace("</body>", f"{compressed_css_tag}\n{compressed_js_tag}\n{BOOTSTRAP_LOADER_SCRIPT}</body>")

    final_size = len(final_html.encode("utf-8"))

    # 7. Validación de integridad del distribuible
    is_valid, validation_errors = verify_bundle(final_html, verbose=verbose)
    if not is_valid:
        print("❌ Error de validación en el archivo generado:", file=sys.stderr)
        for err in validation_errors:
            print(f"   - {err}", file=sys.stderr)
        return False

    # 8. Escribir archivo distribuible
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(final_html)

    elapsed_time = (time.time() - start_time) * 1000
    total_raw_size = raw_html_size + raw_css_size + raw_js_size
    total_reduction_pct = ((total_raw_size - final_size) / total_raw_size) * 100 if total_raw_size else 0

    # 9. Informe detallado de compresión
    print("\n" + "=" * 70)
    print(f"✨ Bundle autónomo ('{os.path.basename(output_path)}') generado con éxito")
    print("=" * 70)
    print(f"⚙️  Modo: {mode.upper()} | Gzip L9 Base64 | CSS: {css_engine} | JS: {js_engine}")
    print(f"⏱️  Tiempo de compilación: {elapsed_time:.1f} ms")
    print("-" * 70)
    html_reduction = (1 - min_html_size / raw_html_size) * 100 if raw_html_size else 0
    css_opt_reduction = (1 - min_css_size / raw_css_size) * 100 if raw_css_size else 0
    css_gzip_reduction = (1 - css_gzip_bytes / min_css_size) * 100 if min_css_size else 0
    js_reduction = (1 - final_js_size / raw_js_size) * 100 if raw_js_size else 0
    js_gzip_reduction = (1 - js_gzip_bytes / final_js_size) * 100 if final_js_size else 0
    print(f"  • HTML Markup:        {raw_html_size:>8,} bytes  ➜  {min_html_size:>8,} bytes  ({html_reduction:>5.1f}% reducción)")
    print(f"  • CSS Styles (Raw):   {raw_css_size:>8,} bytes  ➜  {min_css_size:>8,} bytes  ({css_opt_reduction:>5.1f}% optimizado)")
    if mode == "prod":
        print(f"  • CSS Gzip (L9):      {css_gzip_bytes:>8,} bytes  ({css_gzip_reduction:>5.1f}% compresión)")
        print(f"  • CSS Base64 Payload: {css_b64_bytes:>8,} bytes")
    print(f"  • JS Concatenado:     {raw_js_size:>8,} bytes")
    print(f"  • JS Optimizado:      {final_js_size:>8,} bytes  ({js_reduction:>5.1f}% reducción)")
    if mode == "prod":
        print(f"  • JS Gzip (L9):       {js_gzip_bytes:>8,} bytes  ({js_gzip_reduction:>5.1f}% compresión)")
        print(f"  • JS Base64 Payload:  {js_b64_bytes:>8,} bytes")
    print("-" * 70)
    print(f"📦 TAMAÑO TOTAL RAW:    {total_raw_size:>8,} bytes ({total_raw_size/1024:.1f} KB)")
    print(f"🚀 TAMAÑO DIST FINAL:   {final_size:>8,} bytes ({final_size/1024:.1f} KB)")
    print(f"📊 REDUCCIÓN TOTAL:     {total_reduction_pct:.1f}% ({total_raw_size - final_size:,} bytes ahorrados)")
    print("=" * 70 + "\n")

    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Empaqueta un HTML y sus recursos locales en un HTML autónomo con Gzip/Base64."
    )
    parser.add_argument("input", help="Ruta del HTML base que declara los recursos que se incorporarán.")
    parser.add_argument("output", help="Ruta del HTML autónomo que se generará.")
    parser.add_argument(
        "--mode",
        choices=["prod", "dev"],
        default="prod",
        help="Modo de compilación: 'prod' o 'dev'."
    )
    parser.add_argument(
        "--fallback-only",
        action="store_true",
        help="Fuerza el uso exclusivo de minificación CSS en Python puro."
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Muestra información detallada de diagnóstico y validación."
    )

    args = parser.parse_args()
    success = build_standalone_html(
        input_file=args.input,
        output_file=args.output,
        mode=args.mode,
        force_fallback=args.fallback_only,
        verbose=args.verbose
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
