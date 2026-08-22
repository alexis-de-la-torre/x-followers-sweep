from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from platform_adapter import (  # noqa: E402
    GooglePubSubPublisher,
    PubSubRuntime,
    PubSubSettings,
)


class ImmediateFuture:
    def __init__(self, value: str = "message-1") -> None:
        self.value = value

    def result(self, timeout=None):
        return self.value


class FakePublisherClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bytes, dict[str, str]]] = []
        self.stopped = False

    def topic_path(self, project: str, topic: str) -> str:
        return f"projects/{project}/topics/{topic}"

    def publish(self, topic_path: str, data: bytes, **attributes: str) -> ImmediateFuture:
        self.calls.append((topic_path, data, attributes))
        return ImmediateFuture()

    def stop(self) -> None:
        self.stopped = True


class FakeStreamingFuture:
    def __init__(self) -> None:
        self.cancelled_value = False
        self.done_callback = None

    def add_done_callback(self, callback) -> None:
        self.done_callback = callback

    def cancel(self) -> None:
        self.cancelled_value = True

    def cancelled(self) -> bool:
        return self.cancelled_value

    def result(self, timeout=None):
        return None


class FakeSubscriberClient:
    def __init__(self) -> None:
        self.callback = None
        self.subscription = None
        self.flow_control = None
        self.closed = False
        self.streaming = FakeStreamingFuture()

    def subscription_path(self, project: str, subscription: str) -> str:
        return f"projects/{project}/subscriptions/{subscription}"

    def subscribe(self, subscription: str, callback, flow_control, await_callbacks_on_shutdown: bool):
        self.subscription = subscription
        self.callback = callback
        self.flow_control = flow_control
        assert await_callbacks_on_shutdown is True
        return self.streaming

    def close(self) -> None:
        self.closed = True


class FakeMessage:
    data = b'{"odTaskId":"task-1"}'
    attributes = {"fulfiller-name": "sweeper-agent"}

    def __init__(self) -> None:
        self.acked = 0
        self.nacked = 0

    def ack(self) -> None:
        self.acked += 1

    def nack(self) -> None:
        self.nacked += 1


class RecordingHandler:
    def __init__(self) -> None:
        self.calls: list[tuple[bytes, dict[str, str]]] = []

    async def handle(self, data: bytes, attributes: dict[str, str], broker_ack: FakeMessage) -> None:
        self.calls.append((data, attributes))
        broker_ack.ack()


def test_google_publisher_applies_environment_prefix_and_serializes_json() -> None:
    client = FakePublisherClient()
    publisher = GooglePubSubPublisher("adlt-s26", "PROD.", client)

    message_id = asyncio.run(publisher.publish("TOPIC", {"id": "sweep-1"}, {"kind": "test"}))

    assert message_id == "message-1"
    topic, data, attributes = client.calls[0]
    assert topic == "projects/adlt-s26/topics/PROD.TOPIC"
    assert json.loads(data) == {"id": "sweep-1"}
    assert attributes == {"kind": "test"}


def test_runtime_subscribes_one_message_at_a_time_and_dispatches_on_app_loop() -> None:
    async def scenario() -> None:
        publisher_client = FakePublisherClient()
        publisher = GooglePubSubPublisher("adlt-s26", client=publisher_client)
        subscriber = FakeSubscriberClient()
        handler = RecordingHandler()
        settings = PubSubSettings("adlt-s26", "new-task.sweeper-agent")
        runtime = PubSubRuntime(settings, handler, publisher, subscriber)

        runtime.start(asyncio.get_running_loop())
        assert subscriber.subscription == "projects/adlt-s26/subscriptions/new-task.sweeper-agent"
        assert subscriber.flow_control.max_messages == 1

        message = FakeMessage()
        await asyncio.to_thread(subscriber.callback, message)

        assert handler.calls == [(message.data, message.attributes)]
        assert message.acked == 1
        assert message.nacked == 0
        assert runtime.health()["started"] is True

        await runtime.stop()
        assert subscriber.streaming.cancelled_value is True
        assert subscriber.closed is True
        assert publisher_client.stopped is True

    asyncio.run(scenario())
