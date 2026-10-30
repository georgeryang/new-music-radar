// False until the Cloud Run job becomes the only writer (README, Cloud Refresh).
// While false, Save & refresh runs update.sh on this Mac.
export const CLOUD_REFRESH = true
export const PROJECT = 'new-music-radar-gry'
export const REGION = 'us-central1'
export const JOB = 'radar-refresh'
export const LOGS_URL = `https://console.cloud.google.com/run/jobs/details/${REGION}/${JOB}/executions?project=${PROJECT}`
