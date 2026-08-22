#!/usr/bin/env python3
"""Create the local Outcome Engine topics and subscriptions idempotently."""

from __future__ import annotations

import os

from google.api_core.exceptions import AlreadyExists
from google.cloud import pubsub_v1


PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "adlt-local")
TOPICS = (
    "OUTCOME.DELIVERY.COMMANDS.DELIVER",
    "OUTCOME.DELIVERY.COMMANDS.INTERNAL.DELIVER",
    "OUTCOME.DELIVERY.COMMANDS.INTERNAL.FLOW-CHOICE-DECISION",
    "OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE",
    "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-ACKNOWLEDGED",
    "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-DONE",
)
SUBSCRIPTIONS = {
    "OUTCOME.DELIVERY.COMMANDS.DELIVER": "OUTCOME.DELIVERY.COMMANDS.DELIVER",
    "OUTCOME.DELIVERY.COMMANDS.INTERNAL.DELIVER": "OUTCOME.DELIVERY.COMMANDS.INTERNAL.DELIVER",
    "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-ACKNOWLEDGED":
        "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-ACKNOWLEDGED",
    "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-DONE":
        "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-DONE",
    # Deliberately unfiltered. Python checks fulfillerName in every payload, so
    # no fulfiller-specific registration or immutable Pub/Sub filter is needed.
    "OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE.sweeper-agent":
        "OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE",
}


def main() -> None:
    if not os.environ.get("PUBSUB_EMULATOR_HOST"):
        raise SystemExit("PUBSUB_EMULATOR_HOST is required; refusing to modify real Pub/Sub")

    publisher = pubsub_v1.PublisherClient()
    subscriber = pubsub_v1.SubscriberClient()
    try:
        for topic in TOPICS:
            path = publisher.topic_path(PROJECT, topic)
            try:
                publisher.create_topic(request={"name": path})
                print(f"created topic {topic}")
            except AlreadyExists:
                print(f"existing topic {topic}")

        for subscription, topic in SUBSCRIPTIONS.items():
            path = subscriber.subscription_path(PROJECT, subscription)
            topic_path = publisher.topic_path(PROJECT, topic)
            try:
                subscriber.create_subscription(request={
                    "name": path,
                    "topic": topic_path,
                    "ack_deadline_seconds": 60,
                })
                print(f"created subscription {subscription}")
            except AlreadyExists:
                print(f"existing subscription {subscription}")
    finally:
        subscriber.close()


if __name__ == "__main__":
    main()
