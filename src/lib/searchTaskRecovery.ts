/** Return running search tasks whose worker is no longer the active pipeline job. */
export function orphanedRunningSearchTasks(tasks: any[], activeJob: any | null): any[] {
  return tasks.filter((task) => {
    if (task?.status !== 'running') return false
    if (!activeJob) return true
    return activeJob.search_task_id !== task.id && activeJob.id !== task.active_job_id
  })
}
