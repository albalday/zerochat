#!/usr/bin/env python3
"""
ZeroChat Project Memory Helper (.zerochat/task.py)
Automates project memory operations (marking tasks done, logging decisions, updating state)
using only Python standard library.
"""

import argparse
from datetime import date
from pathlib import Path
import re
import sys


def get_zerochat_dir(override_dir=None):
    if override_dir:
        p = Path(override_dir).resolve()
    else:
        p = Path(__file__).resolve().parent
    if not p.is_dir():
        raise FileNotFoundError(f"Memory directory not found: {p}")
    return p


def read_file(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    return path.read_text(encoding="utf-8")


def write_file(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def parse_milestone_and_num(task_id: str):
    m = re.match(r"^M(\d+)-T(\d+)$", task_id.strip(), re.IGNORECASE)
    if not m:
        raise ValueError(f"Invalid task ID: '{task_id}'. Expected format: M<n>-T<m> (e.g. M8-T1)")
    return f"M{m.group(1)}", int(m.group(1)), int(m.group(2))


def get_next_decision_id(log_content: str, milestone_num: int) -> str:
    pattern = rf"M{milestone_num}-D(\d+)"
    existing = [int(num) for num in re.findall(pattern, log_content)]
    next_idx = max(existing) + 1 if existing else 1
    return f"M{milestone_num}-D{next_idx}"


def find_next_pending_task(plan_content: str, current_milestone_prefix: str):
    lines = plan_content.splitlines()
    in_current_milestone = False

    milestone_header_re = re.compile(r"^##\s+(M\d+)\b", re.IGNORECASE)
    pending_task_re = re.compile(r"^\s*-\s*\[ \]\s*(M\d+-T\d+\s+.*)$", re.IGNORECASE)

    for line in lines:
        header_match = milestone_header_re.match(line)
        if header_match:
            m_id = header_match.group(1).upper()
            if m_id == current_milestone_prefix.upper():
                in_current_milestone = True
            elif in_current_milestone:
                break
        elif in_current_milestone:
            task_match = pending_task_re.match(line)
            if task_match:
                return task_match.group(1).strip()

    return None


def cmd_done(args, base_dir: Path):
    plan_path = base_dir / "plan.md"
    log_path = base_dir / "log.md"
    state_path = base_dir / "state.md"

    plan_content = read_file(plan_path)
    state_content = read_file(state_path)
    log_content = read_file(log_path) if log_path.is_file() else "# Decision log\n\n"

    task_id = args.task_id.strip().upper()
    milestone_prefix, m_num, _ = parse_milestone_and_num(task_id)
    today_str = args.date or date.today().isoformat()

    task_regex = re.compile(
        rf"^(\s*-\s*\[ \]\s*{re.escape(task_id)}\b[^\n]*)$",
        re.MULTILINE | re.IGNORECASE
    )
    match = task_regex.search(plan_content)
    if not match:
        done_check = re.search(rf"^\s*-\s*\[x\]\s*{re.escape(task_id)}\b", plan_content, re.MULTILINE | re.IGNORECASE)
        if done_check:
            print(f"Warning: Task {task_id} was already marked done in {plan_path.name}.")
        else:
            raise ValueError(f"Pending task '{task_id}' not found in {plan_path.name}.")
    else:
        original_line = match.group(1)
        body = re.sub(r"^\s*-\s*\[ \]\s*", "", original_line)
        if args.drop:
            replacement = f"- [x] {body} (dropped: {args.drop.strip()})"
        else:
            replacement = f"- [x] {body} ({today_str})"
        plan_content = plan_content[:match.start()] + replacement + plan_content[match.end():]
        write_file(plan_path, plan_content)
        print(f"✔ {plan_path.name}: {replacement}")

    if args.decision:
        decision_text = args.decision.strip()
        decision_id = get_next_decision_id(log_content, m_num)
        log_entry = f"- {today_str} {decision_id} {decision_text} ({task_id})"
        if not log_content.endswith("\n"):
            log_content += "\n"
        log_content += log_entry + "\n"
        write_file(log_path, log_content)
        print(f"✔ {log_path.name}: {log_entry}")

    if args.next is not None:
        next_task_str = args.next.strip()
    else:
        auto_next = find_next_pending_task(plan_content, milestone_prefix)
        next_task_str = auto_next if auto_next else "none pending"

    if re.search(r"^-\s*Next task:.*$", state_content, re.MULTILINE):
        state_content = re.sub(
            r"^-\s*Next task:.*$",
            f"- Next task: {next_task_str}",
            state_content,
            flags=re.MULTILINE
        )
    else:
        state_content += f"\n- Next task: {next_task_str}"

    if re.search(r"^-\s*Last updated:.*$", state_content, re.MULTILINE):
        state_content = re.sub(
            r"^-\s*Last updated:.*$",
            f"- Last updated: {today_str}",
            state_content,
            flags=re.MULTILINE
        )
    else:
        state_content += f"\n- Last updated: {today_str}"

    write_file(state_path, state_content)
    print(f"✔ {state_path.name}: Next task -> {next_task_str} (Last updated: {today_str})")


def cmd_add_task(args, base_dir: Path):
    plan_path = base_dir / "plan.md"
    plan_content = read_file(plan_path)

    m_prefix = args.milestone.strip().upper()
    if not re.match(r"^M\d+$", m_prefix):
        raise ValueError(f"Invalid milestone: '{args.milestone}'. Expected format: M<n> (e.g. M8)")

    desc = args.description.strip()
    if not desc:
        raise ValueError("Task description cannot be empty.")

    pattern = rf"^\s*-\s*\[[ x]\]\s*{m_prefix}-T(\d+)\b"
    existing_tasks = [int(n) for n in re.findall(pattern, plan_content, re.MULTILINE | re.IGNORECASE)]
    next_task_num = max(existing_tasks) + 1 if existing_tasks else 1
    new_task_id = f"{m_prefix}-T{next_task_num}"
    new_task_line = f"- [ ] {new_task_id} {desc}"

    milestone_header_re = re.compile(rf"^##\s+{m_prefix}\b[^\n]*", re.MULTILINE | re.IGNORECASE)
    m_header = milestone_header_re.search(plan_content)
    if not m_header:
        raise ValueError(f"Milestone '{m_prefix}' not found in {plan_path.name}.")

    next_m_header = re.search(r"^##\s+M\d+\b", plan_content[m_header.end():], re.MULTILINE | re.IGNORECASE)
    section_end = (m_header.end() + next_m_header.start()) if next_m_header else len(plan_content)

    section_text = plan_content[m_header.start():section_end]
    last_task = None
    for m in re.finditer(rf"^\s*-\s*\[[ x]\].*$", section_text, re.MULTILINE):
        last_task = m

    if last_task:
        insert_pos = m_header.start() + last_task.end()
        plan_content = plan_content[:insert_pos] + "\n" + new_task_line + plan_content[insert_pos:]
    else:
        insert_pos = section_end
        stripped = plan_content[:insert_pos].rstrip()
        plan_content = stripped + "\n" + new_task_line + "\n\n" + plan_content[insert_pos:].lstrip()

    write_file(plan_path, plan_content)
    print(f"✔ {plan_path.name}: Added {new_task_line}")


def cmd_next(args, base_dir: Path):
    state_path = base_dir / "state.md"
    state_content = read_file(state_path)
    today_str = args.date or date.today().isoformat()
    next_task_str = args.task.strip()

    state_content = re.sub(
        r"^-\s*Next task:.*$",
        f"- Next task: {next_task_str}",
        state_content,
        flags=re.MULTILINE
    )
    state_content = re.sub(
        r"^-\s*Last updated:.*$",
        f"- Last updated: {today_str}",
        state_content,
        flags=re.MULTILINE
    )
    write_file(state_path, state_content)
    print(f"✔ {state_path.name}: Next task -> {next_task_str} (Last updated: {today_str})")


def cmd_status(args, base_dir: Path):
    state_path = base_dir / "state.md"
    state_content = read_file(state_path)
    print(state_content.strip())


def main():
    parser = argparse.ArgumentParser(description="ZeroChat Project Memory Helper")
    parser.add_argument("--dir", help="ZeroChat memory directory .zerochat (optional)", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    done_p = subparsers.add_parser("done", help="Mark a task as completed")
    done_p.add_argument("task_id", help="Task ID (e.g. M8-T1)")
    done_p.add_argument("-d", "--decision", help="Decision text to record in log.md", default=None)
    done_p.add_argument("-n", "--next", help="Next task for state.md (automatically detected if omitted)", default=None)
    done_p.add_argument("--drop", help="Reason if task is dropped", default=None)
    done_p.add_argument("--date", help="Date YYYY-MM-DD (defaults to today)", default=None)

    add_p = subparsers.add_parser("add-task", help="Add a new task to a milestone in plan.md")
    add_p.add_argument("milestone", help="Milestone (e.g. M8)")
    add_p.add_argument("description", help="Task description")

    next_p = subparsers.add_parser("next", help="Manually set next task in state.md")
    next_p.add_argument("task", help="Next task ID or description")
    next_p.add_argument("--date", help="Date YYYY-MM-DD (defaults to today)", default=None)

    subparsers.add_parser("status", help="Display current state.md content")

    args = parser.parse_args()
    try:
        base_dir = get_zerochat_dir(args.dir)
        if args.command == "done":
            cmd_done(args, base_dir)
        elif args.command == "add-task":
            cmd_add_task(args, base_dir)
        elif args.command == "next":
            cmd_next(args, base_dir)
        elif args.command == "status":
            cmd_status(args, base_dir)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
