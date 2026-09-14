import json
import importlib.util
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from harness import ALLOWED, HostTools, ProtocolError, agent_class, decode, validate_start


def call(name, arguments="{}", call_id="call_1"):
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=arguments))


class HarnessTest(unittest.TestCase):
    def test_start_and_protocol_boundaries(self):
        start = {"type": "start", "question": "지난 주 승인 시각?", "history": [], "tools": [
            {"name": "cashflow_status", "description": "read", "parameters": {"type": "object"}}]}
        self.assertEqual(validate_start(decode(json.dumps(start))), start)
        for invalid in [dict(start, callbackUrl="https://evil"), dict(start, history=[{"role": "system", "content": "write"}]),
                        dict(start, tools=[dict(start["tools"][0], name="terminal")])]:
            with self.assertRaises(ProtocolError):
                validate_start(invalid)

    def test_denied_batch_never_calls_host_or_native(self):
        class Native:
            def _execute_tool_calls(self, *args):
                raise AssertionError("native executor must never run")
        agent = agent_class(Native)()
        agent.host_tools = HostTools(ALLOWED, lambda value: self.fail("host called"), lambda: {})
        for name in ("terminal", "delegate_task", "write_file", "execute_code", "browser_click"):
            with self.assertRaises(ProtocolError):
                agent._execute_tool_calls(SimpleNamespace(tool_calls=[call("cashflow_status"), call(name, call_id="bad")]), [], "task")

    def test_roundtrip_and_wrong_id(self):
        events, messages = [], []
        tools = HostTools({"cashflow_status"}, events.append,
                          lambda: {"type": "tool_result", "id": "call_1", "result": {"status": "APPROVED"}})
        tools.execute([call("cashflow_status")], messages)
        self.assertEqual(events[0]["type"], "tool_call")
        self.assertEqual(json.loads(messages[0]["content"]), {"status": "APPROVED"})
        tools.receive = lambda: {"type": "tool_result", "id": "wrong", "result": {}}
        with self.assertRaises(ProtocolError):
            tools.execute([call("cashflow_status")], [])
        with self.assertRaises(ProtocolError):
            tools.execute([call("cashflow_status", "[]")], [])

    @unittest.skipUnless(importlib.util.find_spec("run_agent"), "install pinned Hermes core to run real loop test")
    def test_real_hermes_loop_native_gemini_transport_and_host_callback(self):
        import httpx
        from harness import run
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {
            "HERMES_HOME": home, "HERMES_BUNDLED_PLUGINS": home, "GEMINI_API_KEY": "non-secret-test",
        }):
            from run_agent import AIAgent
            from agent.gemini_native_adapter import GeminiNativeClient
            requests, events = [], []

            def respond(request):
                requests.append(json.loads(request.content))
                parts = ([{"functionCall": {"name": "cashflow_status", "args": {}, "id": "call_1"},
                           "thoughtSignature": "test-signature"}] if len(requests) == 1
                         else [{"text": "📌 에코스타트업: 조직장 승인 완료"}])
                value = {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
                         "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20,
                                           "thoughtsTokenCount": 7, "totalTokenCount": 127}}
                if "streamGenerateContent" in str(request.url):
                    return httpx.Response(200, text="data: " + json.dumps(value) + "\n\n",
                                          headers={"content-type": "text/event-stream"})
                return httpx.Response(200, json=value)

            client = GeminiNativeClient(api_key="non-secret-test", http_client=httpx.Client(
                transport=httpx.MockTransport(respond)))
            with patch.object(AIAgent, "_create_openai_client", return_value=client):
                run({"type": "start", "question": "에코스타트업 승인됐어?", "history": [], "tools": [
                    {"name": "cashflow_status", "description": "Read state", "parameters": {"type": "object"}}]},
                    events.append, lambda: {"type": "tool_result", "id": "call_1",
                                           "result": {"project": "에코스타트업", "state": "APPROVED"}})
            self.assertEqual(len(requests), 2)
            self.assertEqual(events[0]["type"], "tool_call")
            self.assertEqual(events[-1]["answer"], "📌 에코스타트업: 조직장 승인 완료")
            self.assertEqual(events[-1]["usage"], {"input": 200, "output": 40, "thinking": 14})
            self.assertFalse(events[-1]["partial"])
            # Test the actual subclass boundary even for forced calls bypassing provider schema validation.
            instance = object.__new__(agent_class(AIAgent))
            instance.host_tools = HostTools(ALLOWED, lambda event: self.fail("denied callback executed"), lambda: {})
            for name in ("terminal", "delegate_task", "write_file"):
                with self.assertRaises(ProtocolError):
                    instance._execute_tool_calls(SimpleNamespace(tool_calls=[call(name)]), [], "task")


if __name__ == "__main__":
    unittest.main()
