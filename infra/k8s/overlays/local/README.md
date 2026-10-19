# Local Kubernetes Rehearsal

This overlay is for local BFF operations rehearsal only.

Safety constraints:

- `BFF_DEPLOY_ENV=local`
- no live Firebase project ID
- no live Firebase Admin credentials
- no Kubernetes CronJobs
- no public ingress
- access by `kubectl port-forward` only

Run:

```bash
bash scripts/k8s_local_rehearsal.sh
```

After the script completes:

```bash
kubectl -n inner-platform-local port-forward svc/mysc-bff 18787:8080
curl http://127.0.0.1:18787/api/v1/health
```
