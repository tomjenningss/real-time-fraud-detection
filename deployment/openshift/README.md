# OpenShift deployment overlay

This overlay is intentionally **not** an apply script. Run `./gate0.sh` first. It performs only
read-only `oc` requests and fails when the configured cluster, namespace permissions, storage, or
security admission cannot be verified. No `oc apply`, `oc create`, or `oc delete` command belongs in
the gate.

The PostgreSQL manifest is a single-replica, synthetic-demonstration database. Its image is a
placeholder until Gate 0 confirms an OpenShift arbitrary-UID-compatible PostgreSQL 17 image available
to the target project. Never substitute a fixed-UID image by granting `anyuid`.

`kustomize build .` is safe and does not contact the cluster. Apply remains deliberately manual after
the gate report is reviewed and image/registry values are set by the deployment owner.
