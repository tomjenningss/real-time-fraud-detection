# TechZone Gate 0

Verified on 4 November 2026 using read-only `oc` requests. No OpenShift resource was applied, created,
patched, or deleted.

## Endpoint and identity

The original kubeconfig server uses the non-resolving hostname
`api-itz-e4co9x.infra01-lb.wdc04.techzone.ibm.com`. The working endpoint is:

```text
https://api.itz-e4co9x.infra01-lb.wdc04.techzone.ibm.com:6443
```

The current context has not yet been rewritten; verification used a per-command `--server` override so the
kubeconfig remained unchanged. The corrected endpoint reports:

- OpenShift `4.19.38`, Kubernetes `1.32.13`;
- authenticated user `kube:admin`;
- current context namespace `default`;
- existing, empty project `itz-e4co9x`, recommended as the deployment namespace instead of `default`.

The user can create projects/namespaces and has the required permissions in `itz-e4co9x` for Deployments,
StatefulSets, Jobs, PVCs, Services, Secrets, ConfigMaps, Routes, NetworkPolicies and ImageStreams. The project
currently has no workloads, PVCs, Routes, NetworkPolicies, ResourceQuotas or LimitRanges. Its allocated UID
and supplemental-group ranges both begin at `1000770000/10000`.

## Capacity and cluster health

All cluster operators reported `Available=True`, `Progressing=False`, and `Degraded=False`.

The cluster has three workers. Each has 16 CPUs, `15500m` allocatable CPU, approximately 61.7 GiB allocatable
memory, approximately 88.5 GiB allocatable ephemeral storage, and a 250-pod limit. At observation time:

| Worker | CPU usage | Memory usage |
| --- | ---: | ---: |
| `itz-e4co9x-worker-1` | about 0.80 cores | about 5.8 GiB |
| `itz-e4co9x-worker-2` | about 1.24 cores | about 6.4 GiB |
| `itz-e4co9x-worker-3` | about 0.47 cores | about 3.6 GiB |

The proposed PostgreSQL request of 500m CPU and 1 GiB memory, with a 2 GiB memory limit, fits the observed
capacity. This is capacity evidence only, not a performance result. Ephemeral capacity is not treated as
persistent storage.

## Persistent storage

Dynamic CSI storage is available. The default StorageClass is `ocs-storagecluster-ceph-rbd`, backed by
`openshift-storage.rbd.csi.ceph.com`, with immediate binding, `Delete` reclaim policy, ext4, and volume
expansion enabled. It supports the planned `ReadWriteOnce` PostgreSQL claim. CephFS classes are also present
for shared storage, but are not required for PostgreSQL.

The storage operator is healthy, its external Ceph cluster is `Connected` with `HEALTH_OK`, existing RBD and
CephFS claims are bound, and matching RBD/CephFS snapshot classes are installed. These observations confirm
that dynamic provisioning is in active use. A new 20 GiB claim was deliberately not created during this
read-only gate, so the exact planned claim has not yet been provisioned.

## SCC and container admission

The `itz-e4co9x:default` service account can use `restricted-v2` and cannot use `anyuid`. `restricted-v2`
requires `MustRunAsRange`, assigned FSGroup and SELinux context, drops all capabilities, disallows privilege
escalation, defaults seccomp to `runtime/default`, and allows PVC, Secret, ConfigMap, projected and `emptyDir`
volumes. This matches the planned security posture.

No test pod was admitted or started during this read-only gate. The selected PostgreSQL 17 image must still
be proven to start under the project-assigned arbitrary UID and write to an RBD-mounted PVC without an
`anyuid`, privileged, root-init or hostPath exception.

## Routes and networking

The default ingress controller is available and not degraded. It uses the wildcard domain
`apps.itz-e4co9x.infra01-lb.wdc04.techzone.ibm.com` with `HostNetwork` endpoint publishing. Route creation is
authorised in `itz-e4co9x`; the namespace currently exposes no Routes. The internal registry has an admitted
reencrypt Route and is backed by a bound PVC.

Cluster networking is healthy `OVNKubernetes`, with pod CIDR `10.128.0.0/14` and service CIDR
`172.30.0.0/16`. The target project currently has no NetworkPolicies, so explicit default-deny and required
allow rules remain deployment work. Egress from a future Glaramara pod to IBM IAM and watsonx Orchestrate
cannot be established from control-plane configuration alone and remains to be tested with an approved
non-mutating connectivity probe after a workload exists.

## Remaining blockers and recommendation

Control-plane Gate 0 is **passed with runtime prerequisites outstanding**. Cluster reachability, version,
health, namespace authority, capacity, dynamic persistent storage, restricted SCC access, ingress, Routes,
registry and networking are verified.

Do not begin the full platform deployment yet. First:

1. update the kubeconfig/context to use the corrected dot-form API hostname and select `itz-e4co9x`;
2. select and pin an OpenShift arbitrary-UID-compatible PostgreSQL 17 image;
3. obtain approval for a minimal preflight that provisions the planned 20 GiB RBD claim and starts only the
   PostgreSQL compatibility probe under `restricted-v2`;
4. verify outbound TLS/DNS from the application namespace to IBM IAM and the configured watsonx Orchestrate
   service endpoint;
5. render and review the final namespace-scoped manifests, Secrets strategy and NetworkPolicies before any
   application resource is applied.

Recommendation: the cluster is suitable for the planned demonstration and ready for the controlled storage,
image and egress preflight. It is not yet ready for full Glaramara deployment until those runtime checks pass.
