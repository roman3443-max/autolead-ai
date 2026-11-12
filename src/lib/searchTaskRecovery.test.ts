import assert from 'node:assert/strict'
import test from 'node:test'
import { orphanedRunningSearchTasks } from './searchTaskRecovery.ts'

test('keeps the search task owned by the active pipeline job', () => {
  const task = { id: 'task-1', status: 'running' }
  assert.deepEqual(orphanedRunningSearchTasks([task], { id: 'job-1', search_task_id: 'task-1' }), [])
})

test('keeps a task when its explicit active job id matches', () => {
  const task = { id: 'task-1', status: 'running', active_job_id: 'job-1' }
  assert.deepEqual(orphanedRunningSearchTasks([task], { id: 'job-1' }), [])
})

test('returns running tasks with no active job for recovery', () => {
  const running = { id: 'task-1', status: 'running' }
  const done = { id: 'task-2', status: 'done' }
  assert.deepEqual(orphanedRunningSearchTasks([running, done], null), [running])
})

test('does not treat unrelated tasks as active', () => {
  const task = { id: 'task-1', status: 'running' }
  assert.deepEqual(orphanedRunningSearchTasks([task], { id: 'job-1', search_task_id: 'task-2' }), [task])
})
