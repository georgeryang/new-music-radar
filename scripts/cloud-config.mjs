// True only while the Cloud Run job is the sole writer; false hands it back to
// the Mac's update.sh (README, Cloud Refresh).
export const CLOUD_REFRESH = true
export const PROJECT = 'new-music-radar-gry'
export const REGION = 'us-central1'
export const JOB = 'radar-refresh'
export const LOGS_URL = `https://console.cloud.google.com/run/jobs/details/${REGION}/${JOB}/executions?project=${PROJECT}`
