from __future__ import annotations

from uuid import UUID

from .schemas import EvidenceBundle, EvidenceReference


class EvidenceRepository:
    """Canonical in-process store; policy retrieves by opaque reference, not model arguments."""

    def __init__(self) -> None:
        self._records: dict[UUID, EvidenceBundle] = {}

    def put(self, bundle: EvidenceBundle) -> EvidenceReference:
        self._records[bundle.investigation_id] = bundle
        return EvidenceReference(
            investigation_id=bundle.investigation_id, transaction_id=bundle.transaction_id
        )

    def get(self, reference: EvidenceReference) -> EvidenceBundle:
        bundle = self._records.get(reference.investigation_id)
        if bundle is None or bundle.transaction_id != reference.transaction_id:
            raise KeyError("canonical evidence reference was not found or identity mismatched")
        return bundle
