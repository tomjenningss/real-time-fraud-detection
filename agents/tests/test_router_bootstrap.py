from __future__ import annotations

from types import SimpleNamespace

import pytest

from fraud_agents.kafka_io import await_assignment_and_validate


class FakeConsumer:
    def __init__(self, committed_offsets, positions, high_watermark=42, first_message=None):
        self.parts = [SimpleNamespace(topic="payments.enriched.demo", partition=0, offset=-1001)]
        self.committed_offsets = committed_offsets
        self.positions = positions
        self.high_watermark = high_watermark
        self.first_message = first_message

    def poll(self, _timeout):
        message, self.first_message = self.first_message, None
        return message

    def assignment(self):
        return self.parts

    def committed(self, _assignment, timeout):
        assert timeout == 5
        return [SimpleNamespace(partition=0, offset=self.committed_offsets)]

    def position(self, _assignment):
        return [SimpleNamespace(partition=0, offset=self.positions)]

    def get_watermark_offsets(self, _partition, timeout):
        assert timeout == 5
        return 0, self.high_watermark

    def seek(self, partition):
        self.positions = partition.offset


def test_new_group_must_match_explicit_boundary():
    consumer = FakeConsumer(-1001, 42)
    assert await_assignment_and_validate(consumer, expected_start_offsets={0: 42}) == {0: 42}


def test_new_group_refuses_missing_or_wrong_boundary():
    with pytest.raises(RuntimeError, match="requires ROUTER_EXPECTED"):
        await_assignment_and_validate(FakeConsumer(-1001, 42), expected_start_offsets={})
    with pytest.raises(RuntimeError, match="does not match"):
        await_assignment_and_validate(
            FakeConsumer(-1001, 43, high_watermark=43), expected_start_offsets={0: 42}
        )


def test_existing_stable_group_resumes_committed_offset():
    consumer = FakeConsumer(87, 99)
    assert await_assignment_and_validate(consumer, expected_start_offsets={0: 42}) == {0: 87}


def test_record_returned_during_assignment_is_buffered_not_discarded():
    message = SimpleNamespace(offset=87)
    consumer = FakeConsumer(87, 99, first_message=message)
    buffered = []
    await_assignment_and_validate(
        consumer, expected_start_offsets={0: 42}, buffered_messages=buffered
    )
    assert buffered == [message]
