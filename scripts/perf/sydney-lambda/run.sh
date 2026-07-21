#!/usr/bin/env bash
#
# Sydney-origin dashboard perf benchmark.
# Runs the exact browser harness (puppeteer-core + @sparticuz/chromium, mirror of the
# dashboard-fetch-waterfall harness) from a throwaway AWS Lambda in ap-southeast-2 (Sydney),
# so TTFB reflects a real Australian client instead of the operator's location.
# It creates a throwaway IAM role + S3 bucket + Lambda, invokes once, writes the JSON result,
# and tears everything down. Cost: a few cents.
#
# Prereqs: aws CLI configured, node + npm, zip.
# Usage:
#   ./run.sh [OUT_JSON]                 # default OUT_JSON=/tmp/liveone-perf-result.json
#   TARGET_URL='https://www.liveone.energy/dashboard/id/5?access=<token>' ./run.sh
#   KEEP=1 ./run.sh                     # leave resources up (skip teardown) to iterate
#
# See README.md for how to analyse the result and interpret it (incl. the headless ttfb=0 caveat).
set -eo pipefail

REGION="${AWS_REGION:-$(aws configure get region || true)}"
: "${REGION:=ap-southeast-2}"
export AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

FN="liveone-perf-syd"
ROLE="liveone-perf-lambda-role"
BUCKET="liveone-perf-${ACCOUNT}-$(echo "$REGION" | tr -d '-')"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-/tmp/liveone-perf-result.json}"
TARGET_URL="${TARGET_URL:-https://www.liveone.energy/dashboard/id/5?access=honest-buttery-tapir}"
HEALTH_URL="${HEALTH_URL:-https://www.liveone.energy/api/health}"

teardown() {
  echo "=== teardown ==="
  aws lambda delete-function --function-name "$FN" 2>/dev/null && echo "  fn deleted" || true
  aws logs delete-log-group --log-group-name "/aws/lambda/$FN" 2>/dev/null || true
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE" 2>/dev/null && echo "  role deleted" || true
  aws s3 rm "s3://$BUCKET/liveone-perf.zip" 2>/dev/null || true
  aws s3api delete-bucket --bucket "$BUCKET" 2>/dev/null && echo "  bucket deleted" || true
}
[ "${KEEP:-0}" = "1" ] || trap teardown EXIT

echo "=== region=$REGION account=$ACCOUNT target=$TARGET_URL ==="

# 1) build the deployment package
cd "$HERE"
npm i --omit=dev --no-audit --no-fund
rm -f /tmp/liveone-perf.zip
zip -qr /tmp/liveone-perf.zip index.mjs package.json node_modules
echo "  zip: $(ls -lh /tmp/liveone-perf.zip | awk '{print $5}')"

# 2) IAM execution role
aws iam create-role --role-name "$ROLE" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --tags Key=Purpose,Value=liveone-perf-test >/dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# 3) upload (zip is ~72MB, over the 50MB direct-upload limit)
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" >/dev/null 2>&1 || true
aws s3 cp /tmp/liveone-perf.zip "s3://$BUCKET/liveone-perf.zip" --only-show-errors

# 4) create the function (retry while the fresh IAM role propagates)
aws lambda delete-function --function-name "$FN" 2>/dev/null || true
for a in 1 2 3 4 5; do
  aws lambda create-function --function-name "$FN" \
    --runtime nodejs20.x --role "arn:aws:iam::${ACCOUNT}:role/${ROLE}" \
    --handler index.handler --timeout 300 --memory-size 2048 --architectures x86_64 \
    --code S3Bucket="$BUCKET",S3Key=liveone-perf.zip \
    --environment "{\"Variables\":{\"TARGET_URL\":\"$TARGET_URL\",\"HEALTH_URL\":\"$HEALTH_URL\"}}" \
    --tags Purpose=liveone-perf-test >/dev/null 2>&1 && { echo "  fn created"; break; } || { echo "  create attempt $a failed; retrying"; sleep 8; }
done
aws lambda wait function-active --function-name "$FN"

# 5) invoke and capture
echo "=== invoking (runs the 10x browser harness in $REGION; ~2-3 min) ==="
aws lambda invoke --function-name "$FN" --cli-read-timeout 320 \
  --invocation-type RequestResponse "$OUT" \
  --query '{StatusCode:StatusCode,FunctionError:FunctionError}' --output json
echo "=== result -> $OUT ==="
echo "analyse with:  python3 analyse.py $OUT   (see README.md)"
