"""Cloud Run IAM-authenticated websocket host; no business credentials in this process."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

from websockets.asyncio.server import serve
from harness import MAX_BYTES, ProtocolError, decode, validate_start


async def health(connection, request):
    if request.path == "/healthz":
        return connection.respond(200, "ok\n")
    if request.path != "/run":
        return connection.respond(404, "not found\n")


async def session(ws):
    child = None
    with tempfile.TemporaryDirectory(prefix="hermes-turn-") as home:
        try:
            async with asyncio.timeout(100):
                start = validate_start(decode(await ws.recv()))
                env = {key: os.environ[key] for key in ("PATH", "PYTHONPATH", "GEMINI_API_KEY") if key in os.environ}
                env.update({"HOME": home, "HERMES_HOME": home, "HERMES_BUNDLED_PLUGINS": home,
                            "HERMES_ENABLE_PROJECT_PLUGINS": "0", "PYTHONUNBUFFERED": "1",
                            "PYTHONDONTWRITEBYTECODE": "1"})
                child = await asyncio.create_subprocess_exec(
                    sys.executable, str(Path(__file__).with_name("harness.py")),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    # Library stderr is deliberately not shipped to Cloud Logging (may contain data).
                    stderr=asyncio.subprocess.DEVNULL, env=env, cwd=home,
                    start_new_session=True, limit=MAX_BYTES + 1,
                )
                child.stdin.write((json.dumps(start, ensure_ascii=False) + "\n").encode())
                await child.stdin.drain()
                while True:
                    reading = asyncio.create_task(child.stdout.readline())
                    disconnected = asyncio.create_task(ws.wait_closed())
                    done, pending = await asyncio.wait({reading, disconnected}, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    if disconnected in done:
                        return
                    raw = reading.result()
                    if not raw:
                        raise ProtocolError("worker_closed")
                    event = decode(raw.decode("utf-8"))
                    if event.get("type") not in {"tool_call", "final", "error"}:
                        raise ProtocolError("invalid_worker_event")
                    await ws.send(json.dumps(event, ensure_ascii=False))
                    if event["type"] in {"final", "error"}:
                        return
                    reply = decode(await ws.recv())
                    if set(reply) != {"type", "id", "result"} or reply["type"] != "tool_result" or reply["id"] != event["id"]:
                        raise ProtocolError("invalid_tool_result")
                    child.stdin.write((json.dumps(reply, ensure_ascii=False) + "\n").encode())
                    await child.stdin.drain()
        except TimeoutError:
            if ws.close_code is None:
                await ws.send('{"type":"error","code":"turn_timeout"}')
        except Exception:
            if ws.close_code is None:
                await ws.send('{"type":"error","code":"harness_protocol_failed"}')
        finally:
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await child.wait()


async def main():
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY must be supplied by the secret mount")
    async with serve(session, "0.0.0.0", int(os.environ.get("PORT", "8080")),
                     process_request=health, max_size=MAX_BYTES, max_queue=4):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
