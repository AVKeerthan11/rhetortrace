import path from 'node:path'
import { expect, test } from '@playwright/test'

const DATA = path.resolve(import.meta.dirname, '../../dataset/speech_01')
const audio = (take: string) => path.join(DATA, 'audio', `${take}.wav`)

test('upload -> processing -> results in the existing overview, finding and explorer', async ({ page }) => {
  const statuses: { state: string; stages: { name: string; state: string }[] | null }[] = []
  page.on('response', async (r) => {
    if (r.url().includes('/api/status/job-')) statuses.push(await r.json())
  })

  await page.goto('/analyze')
  await page.getByLabel('Choose your recording').setInputFiles(audio('synth_01'))
  await page.getByLabel('Choose the transcript').setInputFiles(path.join(DATA, 'transcript.txt'))
  await page.getByLabel('Choose two or more recordings').setInputFiles([audio('good_01'), audio('good_03')])
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/analyze') && r.request().method() === 'POST')
  await page.getByRole('button', { name: /^Analyse/ }).click()

  const res = await posted
  expect(res.status()).toBe(202)
  const { run_id } = await res.json()
  expect(run_id).toMatch(/^job-/)
  await expect(page).toHaveURL(new RegExp(`/analyze/${run_id}$`))

  // the server finishes; the page moves on to the results by itself
  const audioServed = page.waitForResponse((r) => r.url().includes(`/api/results/${run_id}/audio/`) && r.status() < 400)
  await expect(page).toHaveURL(new RegExp(`/take/${run_id}$`), { timeout: 90_000 })
  const last = statuses.at(-1)!
  expect(last.state).toBe('succeeded')
  expect(last.stages!.map((s) => [s.name, s.state])).toEqual(
    ['ingest', 'align', 'features', 'baseline', 'detection', 'flaws', 'export'].map((n) => [n, 'done']))

  // overview, from /results
  await expect(page.getByText('Your recording · synth_01.wav').first()).toBeVisible()
  await expect(page.getByText(/compared with the reference deliveries you chose/)).toBeVisible()
  await expect(page.getByText('6 moments differ from the reference deliveries.')).toBeVisible()
  const audioRes = await audioServed
  expect(audioRes.headers()['content-type']).toContain('audio/flac')

  // a finding: reference audio comes from the server, named as uploaded
  await page.getByRole('link', { name: /Start with the most important finding/ }).click()
  await expect(page).toHaveURL(new RegExp(`/take/${run_id}/finding/1$`))
  await expect(page.getByText(/same words · good_0[13]\.wav/)).toBeVisible()

  // the explorer
  await page.goto(`/take/${run_id}/explore`)
  await expect(page.getByText('Timeline explorer')).toBeVisible()
})

test('a transcript that does not match the built-in script is refused with the reason', async ({ page }) => {
  await page.goto('/analyze')
  await page.getByLabel('Choose your recording').setInputFiles(audio('synth_01'))
  await page.getByRole('tab', { name: 'Paste text' }).click()
  await page.getByLabel('Transcript text').fill('This is certainly not the text of the speech at all.')
  await page.getByRole('tab', { name: 'Built-in' }).click()
  await page.getByRole('radio', { name: /Speech 01/ }).click()
  await page.getByRole('button', { name: /^Analyse/ }).click()

  const alert = page.getByRole('alert')
  await expect(alert.getByText('The transcript cannot be used')).toBeVisible()
  await expect(alert.getByText(/differs from speech_01's script/)).toBeVisible()
  await expect(alert.getByText('invalid_transcript · ingest')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Could not analyse synth_01\.wav/ })).toBeVisible()
})

test('without the analysis server the demo still works', async ({ page }) => {
  await page.route('**/api/**', (r) => r.abort())
  await page.goto('/analyze')
  await expect(page.getByText('The analysis server is not running')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Analyse/ })).toBeDisabled()
  await page.goto('/take/speech_01__synth_01')
  await expect(page.getByText(/Demo recording: \d+ flaws were injected/)).toBeVisible()
})
