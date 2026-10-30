FROM node:24-slim

# gh comes from GitHub's apt repo: verify-deploy.sh needs `gh run list --commit`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg tzdata \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=America/New_York

COPY entry.sh /entry.sh
# ENTRYPOINT, not CMD: Cloud Run's --args replace CMD.
ENTRYPOINT ["bash", "/entry.sh"]
