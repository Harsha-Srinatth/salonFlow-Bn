#!/bin/bash
# EC2 first-boot setup (Amazon Linux 2023). The SSM agent is preinstalled; deploys arrive
# through `aws ssm send-command` running deploy.sh, so no SSH port is opened.
set -euxo pipefail
dnf install -y docker
systemctl enable --now docker
mkdir -p /opt/sahasra
