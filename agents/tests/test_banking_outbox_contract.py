from pathlib import Path


def test_banking_watermark_claim_depends_on_published_raw_payment() -> None:
    source = (
        Path(__file__).parents[1] / "src" / "fraud_agents" / "database.py"
    ).read_text()

    assert "event.aggregate_type <> 'banking_payment_watermark'" in source
    assert "prerequisite.aggregate_type = 'banking_payment_raw'" in source
    assert "prerequisite.status = 'PUBLISHED'" in source
