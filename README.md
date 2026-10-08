# result-worker (deploy publicly for n8n Cloud)

Environment variables:
- API_KEY      (required) long random string; paste the same value in the two HTTP nodes in n8n
- PUBLIC_URL   (optional) e.g. https://my-worker.onrender.com ; used for download links
- OUTPUT_DIR   (optional) default /data/results ; attach a persistent disk here if you want files to survive restarts

Endpoints: GET /health, POST /process (x-api-key), GET /files/..., GET /zip/...
Needs at least 1 GB RAM (Chromium).
