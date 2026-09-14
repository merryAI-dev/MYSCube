import importlib.util
import json
import unittest
from unittest.mock import patch


@unittest.skipUnless(importlib.util.find_spec("websockets") and importlib.util.find_spec("httpx"),
                     "install pinned Hermes core to run websocket tests")
class ServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_health_and_invalid_start_never_spawn(self):
        import httpx
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve
        from service import health, session
        async with serve(session, "127.0.0.1", 0, process_request=health) as server:
            port = server.sockets[0].getsockname()[1]
            async with httpx.AsyncClient() as client:
                result = await client.get(f"http://127.0.0.1:{port}/healthz")
                self.assertEqual((result.status_code, result.text), (200, "ok\n"))
            with patch("service.asyncio.create_subprocess_exec", side_effect=AssertionError("must not spawn")) as spawn:
                async with connect(f"ws://127.0.0.1:{port}/run") as ws:
                    await ws.send(json.dumps({"type": "start", "question": "write", "tools": [
                        {"name": "terminal", "description": "bad", "parameters": {"type": "object"}}]}))
                    self.assertEqual(json.loads(await ws.recv())["type"], "error")
                spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
