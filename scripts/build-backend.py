#!/usr/bin/env python3
"""Compilador AST de py/ a zerochat.py en un espacio de nombres plano."""

from __future__ import annotations

import argparse
import ast
from collections import defaultdict
from dataclasses import dataclass, field
import heapq
import json
from pathlib import Path
import re
import stat
import sys

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PY_DIR = ROOT_DIR / "py"
DEFAULT_OUTPUT = ROOT_DIR / "zerochat.py"

PACKAGE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

HEADER_DOCSTRING = '''"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación del entorno MCP local `~/zerochat/.venv`.
2. Servidor local HTTP JSON-RPC con autenticación estricta por token diario e identificación con la cuenta del sistema.
3. Herramientas locales seguras: read_file, edit_file, list_directory, run_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""'''


class BackendBuildError(ValueError):
    """Error de validación o compilación AST del backend Python."""


@dataclass
class ModuleInfo:
    mod_id: str
    path: Path
    source: str
    tree: ast.Module
    defined_symbols: set[str] = field(default_factory=set)
    rebound_globals: set[str] = field(default_factory=set)
    internal_imports: list[tuple[str, str]] = field(default_factory=list)
    stripped_lines: set[int] = field(default_factory=set)
    main_guard_source: str = ""


def extract_top_level_symbols(tree: ast.Module) -> set[str]:
    """Devuelve los nombres definidos en el nivel superior de un módulo (sin imports)."""
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for sub in ast.walk(target):
                    if isinstance(sub, ast.Name):
                        names.add(sub.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def extract_rebound_globals(tree: ast.Module) -> set[str]:
    """Devuelve los nombres que el módulo reasigna con una declaración `global`."""
    return {name for node in ast.walk(tree) if isinstance(node, ast.Global) for name in node.names}


def _is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If):
        return False
    test = node.test
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq) and len(test.comparators) == 1):
        return False
    left, right = test.left, test.comparators[0]
    return (
        (isinstance(left, ast.Name) and left.id == "__name__" and isinstance(right, ast.Constant) and right.value == "__main__")
        or (isinstance(right, ast.Name) and right.id == "__name__" and isinstance(left, ast.Constant) and left.value == "__main__")
    )


def _mark_node_lines(node: ast.AST, stripped: set[int]) -> None:
    start = getattr(node, "lineno", None)
    end = getattr(node, "end_lineno", None)
    if start is not None and end is not None:
        stripped.update(range(start, end + 1))


def _discover_modules(py_dir: Path) -> tuple[dict[str, ModuleInfo], set[str]]:
    if not py_dir.is_dir():
        raise BackendBuildError(f"No existe el directorio fuente: {py_dir}")

    package_dirs: set[str] = set()
    package_modules: dict[str, ModuleInfo] = {}
    for entry in sorted(py_dir.iterdir(), key=lambda p: p.name):
        if entry.name.startswith(".") or entry.name == "__pycache__":
            continue
        if entry.is_file():
            if entry.suffix == ".py":
                raise BackendBuildError(
                    f"Archivo suelto en py/: {entry.name}. Todo módulo vive en un paquete: py/<paquete>/<modulo>.py."
                )
            continue
        if not PACKAGE_NAME_RE.match(entry.name):
            raise BackendBuildError(f"Nombre de paquete no válido en py/: {entry.name}")
        package_dirs.add(entry.name)
        for child in sorted(entry.iterdir(), key=lambda p: p.name):
            if child.name.startswith(".") or child.name == "__pycache__":
                continue
            if child.is_dir():
                raise BackendBuildError(f"Subdirectorio no permitido dentro de py/{entry.name}/: {child.name}")
            if child.suffix != ".py":
                continue
            if child.name == "__init__.py":
                _validate_init_file(child)
                continue
            if not PACKAGE_NAME_RE.match(child.stem):
                raise BackendBuildError(f"Nombre de módulo no válido: py/{entry.name}/{child.name}")
            mod_id = f"{entry.name}.{child.stem}"
            source = child.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(child))
            package_modules[mod_id] = ModuleInfo(
                mod_id=mod_id,
                path=child,
                source=source,
                tree=tree,
                defined_symbols=extract_top_level_symbols(tree),
                rebound_globals=extract_rebound_globals(tree),
            )

    return package_modules, package_dirs


def _validate_init_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        raise BackendBuildError(f"{path} solo puede estar vacío o contener su docstring (sin código ni símbolos).")


def _collect_and_validate_imports(
    module: ModuleInfo,
    package_modules: dict[str, ModuleInfo],
    package_dirs: set[str],
    future_imports: set[str],
    plain_imports: set[tuple[str, str | None]],
    from_imports: dict[tuple[str, int], set[tuple[str, str | None]]],
) -> None:
    top_level_nodes = set(module.tree.body)

    for node in ast.walk(module.tree):
        if isinstance(node, ast.Import):
            is_top = node in top_level_nodes
            for alias in node.names:
                root = alias.name.split(".", 1)[0]
                if root == "py" or root in package_dirs:
                    raise BackendBuildError(
                        f"Módulo '{module.mod_id}' usa import prohibido 'import {alias.name}'. "
                        "Entre módulos propios solo se permite 'from paquete.modulo import nombre'."
                    )
            if is_top:
                _mark_node_lines(node, module.stripped_lines)
                for alias in node.names:
                    plain_imports.add((alias.name, alias.asname))

        elif isinstance(node, ast.ImportFrom):
            is_top = node in top_level_nodes
            mod = node.module or ""
            parts = mod.split(".") if mod else []
            root = parts[0] if parts else ""

            if node.level > 0:
                raise BackendBuildError(
                    f"Módulo '{module.mod_id}' usa import relativo. "
                    "Usa siempre 'from paquete.modulo import nombre'."
                )

            if root == "py" or root in package_dirs:
                if not is_top:
                    raise BackendBuildError(
                        f"Módulo '{module.mod_id}' importa '{mod}' fuera del nivel superior del módulo."
                    )
                if root == "py":
                    raise BackendBuildError(
                        f"Módulo '{module.mod_id}' debe importar 'from paquete.modulo import nombre' sin prefijo 'py.'."
                    )
                if len(parts) != 2 or mod not in package_modules:
                    raise BackendBuildError(
                        f"Módulo '{module.mod_id}' importa de '{mod}'; "
                        "entre módulos propios solo se admite 'from paquete.modulo import nombre' sobre módulos existentes."
                    )
                _mark_node_lines(node, module.stripped_lines)
                for alias in node.names:
                    if alias.name == "*":
                        raise BackendBuildError(f"Módulo '{module.mod_id}' no puede usar 'from {mod} import *'.")
                    if alias.asname is not None:
                        raise BackendBuildError(
                            f"Módulo '{module.mod_id}' no puede usar alias en imports internos ('{alias.name} as {alias.asname}')."
                        )
                    module.internal_imports.append((mod, alias.name))
                continue

            if is_top:
                _mark_node_lines(node, module.stripped_lines)
                if mod == "__future__":
                    for alias in node.names:
                        future_imports.add(alias.name)
                else:
                    bucket = from_imports[(mod, node.level)]
                    for alias in node.names:
                        bucket.add((alias.name, alias.asname))


def _topological_order(package_modules: dict[str, ModuleInfo]) -> list[ModuleInfo]:
    deps: dict[str, set[str]] = {mod_id: set() for mod_id in package_modules}
    dependents: dict[str, set[str]] = {mod_id: set() for mod_id in package_modules}

    for mod_id, info in package_modules.items():
        for target_mod, symbol in info.internal_imports:
            target = package_modules[target_mod]
            if symbol not in target.defined_symbols:
                raise BackendBuildError(
                    f"Módulo '{mod_id}' importa '{symbol}' desde '{target_mod}', pero no está definido en su nivel superior."
                )
            if symbol in target.rebound_globals:
                raise BackendBuildError(
                    f"Módulo '{mod_id}' importa '{symbol}' desde '{target_mod}', que lo reasigna con 'global': "
                    "como paquete conservaría el valor inicial. Léelo con una función de su módulo."
                )
            if target_mod == mod_id:
                raise BackendBuildError(f"Dependencia circular: '{mod_id}' se importa a sí mismo.")
            if target_mod not in deps[mod_id]:
                deps[mod_id].add(target_mod)
                dependents[target_mod].add(mod_id)

    in_degree = {mod_id: len(d) for mod_id, d in deps.items()}
    ready = [mod_id for mod_id, deg in in_degree.items() if deg == 0]
    heapq.heapify(ready)
    ordered: list[ModuleInfo] = []

    while ready:
        current = heapq.heappop(ready)
        ordered.append(package_modules[current])
        for child in dependents[current]:
            in_degree[child] -= 1
            if in_degree[child] == 0:
                heapq.heappush(ready, child)

    if len(ordered) != len(package_modules):
        remaining = sorted(set(package_modules) - {m.mod_id for m in ordered})
        cycle = _find_cycle(remaining, deps)
        raise BackendBuildError(f"Dependencia circular detectada entre módulos de py/: {' -> '.join(cycle)}")

    return ordered


def _find_cycle(nodes: list[str], deps: dict[str, set[str]]) -> list[str]:
    node_set = set(nodes)
    state: dict[str, int] = {}
    stack: list[str] = []

    def dfs(u: str) -> list[str] | None:
        state[u] = 1
        stack.append(u)
        for v in sorted(deps[u] & node_set):
            if state.get(v, 0) == 1:
                idx = stack.index(v)
                return stack[idx:] + [v]
            if state.get(v, 0) == 0:
                res = dfs(v)
                if res:
                    return res
        stack.pop()
        state[u] = 2
        return None

    for n in nodes:
        if state.get(n, 0) == 0:
            res = dfs(n)
            if res:
                return res
    return nodes


def _extract_module_body(module: ModuleInfo) -> str:
    lines = module.source.splitlines(keepends=True)
    stripped = set(module.stripped_lines)

    if lines and lines[0].startswith("#!"):
        stripped.add(1)

    for node in module.tree.body:
        if _is_main_guard(node):
            segment = ast.get_source_segment(module.source, node)
            if segment:
                module.main_guard_source = segment.rstrip() + "\n"
            _mark_node_lines(node, stripped)

    kept = [line for idx, line in enumerate(lines, start=1) if idx not in stripped]
    text = "".join(kept).strip("\n")
    return (text + "\n") if text else ""


def _format_imports(
    future_imports: set[str],
    plain_imports: set[tuple[str, str | None]],
    from_imports: dict[tuple[str, int], set[tuple[str, str | None]]],
) -> str:
    blocks: list[str] = []
    if future_imports:
        blocks.append("\n".join(f"from __future__ import {name}" for name in sorted(future_imports)))

    import_lines: list[str] = []
    for name, asname in sorted(plain_imports, key=lambda item: (item[0], item[1] or "")):
        import_lines.append(f"import {name} as {asname}" if asname else f"import {name}")
    for (mod, level), items in sorted(from_imports.items(), key=lambda entry: (entry[0][1], entry[0][0])):
        prefix = "." * level + mod
        formatted_items = [
            f"{name} as {asname}" if asname else name
            for name, asname in sorted(items, key=lambda item: (item[0], item[1] or ""))
        ]
        import_lines.append(f"from {prefix} import {', '.join(formatted_items)}")
    if import_lines:
        blocks.append("\n".join(import_lines))

    return "\n\n".join(blocks)


def compile_backend(py_dir: Path = DEFAULT_PY_DIR) -> str:
    """Compila el árbol py/ en un único script Python determinista en un espacio de nombres plano."""
    package_modules, package_dirs = _discover_modules(py_dir)
    if not package_modules:
        raise BackendBuildError(f"No se encontraron módulos Python en {py_dir}")

    # Detección de colisiones de símbolos entre todos los módulos.
    symbol_owners: dict[str, str] = {}
    for mod in package_modules.values():
        for sym in sorted(mod.defined_symbols):
            if sym in symbol_owners:
                raise BackendBuildError(
                    f"Colisión de símbolo '{sym}' definido en '{symbol_owners[sym]}' y '{mod.mod_id}'."
                )
            symbol_owners[sym] = mod.mod_id

    future_imports: set[str] = set()
    plain_imports: set[tuple[str, str | None]] = set()
    from_imports: dict[tuple[str, int], set[tuple[str, str | None]]] = defaultdict(set)

    for mod in package_modules.values():
        _collect_and_validate_imports(mod, package_modules, package_dirs, future_imports, plain_imports, from_imports)

    parts: list[str] = ["#!/usr/bin/env python3\n" + HEADER_DOCSTRING.strip() + "\n"]
    imports_block = _format_imports(future_imports, plain_imports, from_imports)
    if imports_block:
        parts.append(imports_block + "\n")

    main_guards: list[str] = []
    for mod in _topological_order(package_modules):
        body = _extract_module_body(mod)
        if body:
            parts.append(f"# --- {mod.mod_id} ---\n{body}")
        if mod.main_guard_source:
            main_guards.append(mod.main_guard_source)
    parts.extend(main_guards)

    result = "\n\n".join(part.rstrip("\n") for part in parts if part.strip()) + "\n"
    # Verificación final de que el código generado es sintácticamente válido.
    ast.parse(result, filename="zerochat.py")
    return result


def build_backend(py_dir: Path = DEFAULT_PY_DIR, output_path: Path = DEFAULT_OUTPUT) -> Path:
    compiled = compile_backend(py_dir)
    output_path.write_text(compiled, encoding="utf-8")
    try:
        mode = output_path.stat().st_mode
        output_path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    return output_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compila py/ en zerochat.py mediante análisis AST.")
    parser.add_argument("--py-dir", type=Path, default=DEFAULT_PY_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--stdout", action="store_true", help="Imprime el código compilado sin escribir fichero.")
    parser.add_argument("--symbols", action="store_true", help="Imprime en JSON los símbolos de nivel superior.")
    args = parser.parse_args(argv)

    try:
        compiled = compile_backend(args.py_dir)
    except BackendBuildError as err:
        print(f"Error compilando backend: {err}", file=sys.stderr)
        return 1

    if args.symbols:
        symbols = sorted(extract_top_level_symbols(ast.parse(compiled)))
        sys.stdout.write(json.dumps(symbols, indent=2) + "\n")
        return 0
    if args.stdout:
        sys.stdout.write(compiled)
        return 0

    build_backend(args.py_dir, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
