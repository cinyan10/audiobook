from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
LOCAL_PYTHON = ROOT / ".venv" / "bin" / "python"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start the web book reader in dev or prod.")
    parser.add_argument("mode", choices=("dev", "prod"), nargs="?", help="Runtime mode.")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind.")
    parser.add_argument("--port", type=int, default=8000, help="Backend port.")
    parser.add_argument("--frontend-port", type=int, default=5173, help="Frontend dev server port.")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without starting them.")
    parser.add_argument("--self-check", action="store_true", help="Run a tiny command-building check and exit.")
    return parser.parse_args()


def preferred_python() -> str:
    return str(LOCAL_PYTHON) if LOCAL_PYTHON.exists() else sys.executable


def package_runner() -> str:
    if shutil.which("bun"):
        return "bun"
    if shutil.which("npm"):
        return "npm"
    raise RuntimeError("bun or npm is required to run the frontend.")


def script_command(runner: str, script: str, extra_args: list[str] | None = None) -> list[str]:
    extra_args = extra_args or []
    if runner == "bun":
        return [runner, "run", script, *extra_args]
    return [runner, "run", script, *(["--", *extra_args] if extra_args else [])]


def dev_commands(host: str, api_port: int, frontend_port: int) -> list[tuple[list[str], Path]]:
    python = preferred_python()
    runner = package_runner()
    return [
        ([python, "-m", "uvicorn", "app.main:app", "--host", host, "--port", str(api_port), "--reload"], ROOT),
        (script_command(runner, "dev", ["--host", host, "--port", str(frontend_port)]), FRONTEND_DIR),
    ]


def prod_build_command() -> tuple[list[str], Path]:
    return script_command(package_runner(), "build"), FRONTEND_DIR


def prod_server_command(host: str, api_port: int) -> tuple[list[str], Path]:
    return [preferred_python(), "-m", "uvicorn", "app.main:app", "--host", host, "--port", str(api_port)], ROOT


def run_command(command: list[str], cwd: Path, dry_run: bool) -> int:
    print(f"$ {' '.join(command)}")
    if dry_run:
        return 0
    try:
        return subprocess.run(command, cwd=cwd, check=False).returncode
    except KeyboardInterrupt:
        return 0


def run_dev(host: str, api_port: int, frontend_port: int, dry_run: bool) -> int:
    commands = dev_commands(host, api_port, frontend_port)
    if dry_run:
        for command, _cwd in commands:
            print(f"$ {' '.join(command)}")
        return 0

    processes: list[subprocess.Popen[bytes]] = []
    try:
        for command, cwd in commands:
            processes.append(subprocess.Popen(command, cwd=cwd))
            time.sleep(0.4)
        print(f"Frontend: http://{host}:{frontend_port}")
        print(f"Backend:  http://{host}:{api_port}")
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    return code
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        stop_processes(processes)


def stop_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    for process in processes:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
    deadline = time.time() + 5
    for process in processes:
        if process.poll() is None:
            timeout = max(0.1, deadline - time.time())
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()


def run_prod(host: str, api_port: int, dry_run: bool) -> int:
    build_command, build_cwd = prod_build_command()
    build_code = run_command(build_command, build_cwd, dry_run)
    if build_code:
        return build_code
    server_command, server_cwd = prod_server_command(host, api_port)
    return run_command(server_command, server_cwd, dry_run)


def self_check() -> int:
    os.environ.setdefault("PYTHONPATH", str(ROOT))
    dev = dev_commands("127.0.0.1", 8000, 5173)
    assert dev[0][0][-1] == "--reload" or "--reload" in dev[0][0]
    assert any(part == "dev" for part in dev[1][0])
    prod_build, _ = prod_build_command()
    assert any(part == "build" for part in prod_build)
    prod_server, _ = prod_server_command("127.0.0.1", 8000)
    assert "uvicorn" in prod_server
    print("self-check passed")
    return 0


def main() -> int:
    args = parse_args()
    if args.self_check:
        return self_check()
    if args.mode is None:
        print("mode is required unless --self-check is used.", file=sys.stderr)
        return 1
    if args.mode == "dev":
        return run_dev(args.host, args.port, args.frontend_port, args.dry_run)
    return run_prod(args.host, args.port, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
