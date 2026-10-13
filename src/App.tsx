import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  Archive,
  BadgeCheck,
  Combine,
  Download,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  LoaderCircle,
  Moon,
  Presentation,
  RotateCcw,
  Shapes,
  ShieldCheck,
  Sun,
  TriangleAlert,
  Upload,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import { convertFile, preloadOffice } from './conversion/convert'
import { ACCEPT, kindOf, pdfName, uniqueNames, type Kind, type Layout } from './conversion/formats'

type Job = {
  id: number
  file: File
  kind: Kind
  status: 'queued' | 'converting' | 'done' | 'error'
  // Engine progress while converting, the reason when failed.
  note?: string
  pdf?: Blob
  // The layout the PDF was made with; shown when it differs from the current choice.
  layout?: Layout
}

type AppProps = {
  convert?: typeof convertFile
  preload?: () => void
}

const ICONS: Record<Kind, LucideIcon> = {
  writer: FileText,
  calc: FileSpreadsheet,
  impress: Presentation,
  draw: Shapes,
  image: ImageIcon,
}

const LAYOUTS: { value: Layout; label: string; hint: string }[] = [
  { value: 'original', label: 'Asli', hint: 'Mempertahankan ukuran dan orientasi halaman asli tiap file.' },
  { value: 'portrait', label: 'Potret', hint: 'Dokumen dan lembar kerja disusun ulang; slide dan gambar disesuaikan ke A4.' },
  { value: 'landscape', label: 'Lanskap', hint: 'Dokumen disusun ulang, lembar kerja disesuaikan ke lebar halaman; slide dan gambar disesuaikan ke A4.' },
]

const LAYOUT_KEY = 'libre-convert:layout'
const TITLE = document.title
const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter'

type Theme = 'light' | 'dark'

const THEME_KEY = 'libre-convert:theme'

// index.html sets data-theme before the first paint; this is the fallback when it did not run (tests, odd setups).
function initialTheme(): Theme {
  const applied = document.documentElement.dataset.theme
  if (applied === 'light' || applied === 'dark') {
    return applied
  }

  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') {
      return stored
    }
  } catch {
    // Storage is unavailable (private mode): fall back to the system setting.
  }

  const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'dark' : 'light'
}

let nextId = 0

export default function App({ convert = convertFile, preload = preloadOffice }: AppProps) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [layout, setLayout] = useState<Layout>(
    () => LAYOUTS.find((item) => item.value === window.localStorage.getItem(LAYOUT_KEY))?.value ?? 'original',
  )
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  // The conversion loop outlives renders, so it reads and writes jobs through this ref; state mirrors it.
  const jobsRef = useRef<Job[]>([])
  const busyRef = useRef(false)

  function commit(next: Job[]) {
    jobsRef.current = next
    setJobs(next)
  }

  function patch(id: number, change: Partial<Job>) {
    commit(jobsRef.current.map((job) => (job.id === id ? { ...job, ...change } : job)))
  }

  function addFiles(files: Iterable<File>) {
    const added: Job[] = []
    const skipped: string[] = []

    for (const file of files) {
      const kind = kindOf(file.name)
      if (kind) {
        added.push({ id: nextId++, file, kind, status: 'queued' })
      } else {
        skipped.push(file.name)
      }
    }

    setNotice(skipped.length > 0 ? `File tidak didukung dilewati: ${skipped.join(', ')}` : undefined)
    if (added.length === 0) {
      return
    }

    commit([...jobsRef.current, ...added])
    if (added.some((job) => job.kind !== 'image')) {
      preload()
    }
  }

  async function run() {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    setBusy(true)

    // Picks up files added or retried while the loop is running.
    for (let job = findQueued(); job; job = findQueued()) {
      const { id } = job
      patch(id, { status: 'converting', note: undefined })

      try {
        const pdf = await convert(job.file, job.kind, layout, (note) => patch(id, { note }))
        patch(id, { status: 'done', note: undefined, pdf, layout })
      } catch (error) {
        patch(id, { status: 'error', note: error instanceof Error ? error.message : String(error) })
      }
    }

    busyRef.current = false
    setBusy(false)
  }

  function findQueued() {
    return jobsRef.current.find((job) => job.status === 'queued')
  }

  function retry(id: number) {
    patch(id, { status: 'queued', note: undefined })
    void run()
  }

  // Converts what is queued, or everything again (e.g. after switching the page layout).
  function convertAll() {
    if (!jobsRef.current.some((job) => job.status === 'queued')) {
      commit(jobsRef.current.map((job) => ({ ...job, status: 'queued', note: undefined, pdf: undefined, layout: undefined })))
    }
    void run()
  }

  async function downloadAll() {
    try {
      const { zipSync } = await import('fflate')
      const names = uniqueNames(outputs.map((output) => output.name))
      const entries = await Promise.all(outputs.map(async (output) => new Uint8Array(await output.pdf.arrayBuffer())))
      // PDFs are already compressed, so store them as-is.
      const zip = zipSync(Object.fromEntries(names.map((name, index) => [name, entries[index]])), { level: 0 })
      save(new Blob([zip], { type: 'application/zip' }), 'hasil-konversi.zip')
    } catch (error) {
      setNotice(`Gagal membuat ZIP: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function merge() {
    try {
      const { mergePdfs } = await import('./conversion/pdf')
      save(await mergePdfs(outputs.map((output) => output.pdf)), 'gabungan.pdf')
    } catch (error) {
      setNotice(`Gagal menggabungkan PDF: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onDrop = useEffectEvent((event: DragEvent) => {
    setDragging(false)
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
      addFiles(event.dataTransfer.files)
    }
  })

  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    if (event.clipboardData?.files.length) {
      addFiles(event.clipboardData.files)
    }
  })

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !busyRef.current && jobsRef.current.length > 0) {
      event.preventDefault()
      convertAll()
    }
  })

  // Files can be dropped or pasted anywhere on the page, not just on the drop zone.
  useEffect(() => {
    const handleDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
        setDragging(true)
      }
    }
    const handleDragLeave = (event: DragEvent) => {
      // relatedTarget is null only when the pointer leaves the window.
      if (!event.relatedTarget) {
        setDragging(false)
      }
    }
    const handleDrop = (event: DragEvent) => onDrop(event)
    const handlePaste = (event: ClipboardEvent) => onPaste(event)
    const handleKeyDown = (event: KeyboardEvent) => onShortcut(event)

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('paste', handlePaste)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('paste', handlePaste)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])


  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171613' : '#f6f2ea')
  }, [theme])

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try {
      window.localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage is unavailable (private mode): the choice simply is not remembered.
    }
  }

  const outputs = jobs.flatMap((job) => (job.pdf ? [{ name: pdfName(job.file.name), pdf: job.pdf }] : []))
  const queued = jobs.filter((job) => job.status === 'queued').length
  const failed = jobs.filter((job) => job.status === 'error').length
  const finished = outputs.length + failed

  useEffect(() => {
    document.title = busy ? `(${finished}/${jobs.length}) ${TITLE}` : TITLE
  }, [busy, finished, jobs.length])

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <ShieldCheck size={20} />
          </span>
          <span className="brand-name">Konversi PDF</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={theme === 'dark'}
          className="theme-switch"
          title={theme === 'dark' ? 'Ganti ke tampilan terang' : 'Ganti ke tampilan gelap'}
          onClick={toggleTheme}
        >
          <Sun size={16} aria-hidden="true" />
          <span className="theme-track" aria-hidden="true">
            <span className="theme-knob" />
          </span>
          <Moon size={16} aria-hidden="true" />
          <span className="sr-only">Mode gelap</span>
        </button>
      </header>

      <section className="hero">
        <h1>Ubah dokumen jadi PDF, file tetap di perangkatmu</h1>
        <p>
          Pilih file Word, Excel, PowerPoint, atau gambar. Semuanya diproses langsung di browser ini, jadi tidak ada file
          yang dikirim ke server mana pun.
        </p>
        <ul className="trust">
          <li>
            <ShieldCheck size={18} aria-hidden="true" />
            File tidak diunggah
          </li>
          <li>
            <BadgeCheck size={18} aria-hidden="true" />
            Gratis, tanpa akun
          </li>
          <li>
            <WifiOff size={18} aria-hidden="true" />
            Bisa offline setelah dibuka sekali
          </li>
        </ul>
      </section>

      <section className="card">
        <label className={['dropzone', jobs.length > 0 && 'dropzone--compact', dragging && 'dropzone--active'].filter(Boolean).join(' ')}>
          <span className="dropzone-badge">
            <Upload size={jobs.length > 0 ? 16 : 18} />
          </span>
          <strong>{jobs.length > 0 ? 'Tambah file lagi' : 'Seret file ke sini'}</strong>
          <span className="muted">
            {jobs.length > 0 ? 'Seret, klik, atau tempel' : 'atau klik di sini untuk memilih file dari perangkatmu.'}
          </span>
          {jobs.length === 0 && <span className="dropzone-cta">Pilih file</span>}
          <input
            className="sr-only"
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(event) => {
              addFiles(event.target.files ?? [])
              event.target.value = ''
            }}
          />
        </label>

        {jobs.length > 0 && (
          <div className="toolbar">
            <label className="field">
              <span className="label">Tata letak halaman</span>
              <select
                value={layout}
                disabled={busy}
                onChange={(event) => {
                  const value = LAYOUTS.find((item) => item.value === event.target.value)?.value ?? 'original'
                  setLayout(value)
                  window.localStorage.setItem(LAYOUT_KEY, value)
                }}
              >
                {LAYOUTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">{LAYOUTS.find((item) => item.value === layout)?.hint}</p>
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              title={SHORTCUT}
              onClick={convertAll}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
              {busy
                ? `Mengonversi ${Math.min(finished + 1, jobs.length)} dari ${jobs.length}`
                : queued > 1
                  ? `Konversi ${queued} file`
                  : queued === 1
                    ? 'Konversi ke PDF'
                    : 'Konversi ulang semua'}
            </button>
          </div>
        )}

        {notice && (
          <p className="callout">
            <TriangleAlert size={16} />
            {notice}
          </p>
        )}

        {jobs.length === 0 ? (
          <p className="empty">Bisa untuk Word, Excel, PowerPoint, OpenDocument, teks, dan gambar (JPG, PNG, WebP).</p>
        ) : (
          <>
            <ul className="jobs">
              {jobs.map((job) => {
                const Icon = ICONS[job.kind]
                const { pdf } = job
                return (
                  <li key={job.id} className="job">
                    <span className="job-icon">
                      <Icon size={18} />
                    </span>
                    <div className="job-copy">
                      <div className="job-name">
                        <strong title={job.file.name}>{job.file.name}</strong>
                        <span className="mono">{formatBytes(job.file.size)}</span>
                      </div>
                      {job.status !== 'queued' && (
                        <p
                          className={
                            job.status === 'error'
                              ? 'job-status job-status--error'
                              : job.pdf
                                ? 'job-status job-status--done'
                                : 'job-status'
                          }
                        >
                          {statusText(job, layout)}
                        </p>
                      )}
                      {job.status === 'converting' && <span className="bar" aria-hidden="true" />}
                    </div>
                    <div className="job-actions">
                      {pdf && (
                        <button type="button" className="button" onClick={() => save(pdf, pdfName(job.file.name))}>
                          <Download size={15} />
                          <span className="button-label">Unduh</span>
                        </button>
                      )}
                      {job.status === 'error' && (
                        <button type="button" className="button" onClick={() => retry(job.id)}>
                          <RotateCcw size={15} />
                          <span className="button-label">Coba lagi</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Hapus ${job.file.name}`}
                        onClick={() => commit(jobsRef.current.filter((item) => item.id !== job.id))}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="footer">
              <span className="mono muted" aria-live="polite">
                {finished === 0 && !busy
                  ? `${jobs.length} file`
                  : `${outputs.length} dari ${jobs.length} selesai${failed > 0 ? `, ${failed} gagal` : ''}`}
              </span>
              <button type="button" className="link" onClick={() => commit([])}>
                Kosongkan
              </button>
              <div className="footer-actions">
                {outputs.length > 1 && (
                  <>
                    <button type="button" className="button" onClick={() => void downloadAll()}>
                      <Archive size={15} />
                      Unduh semua (ZIP)
                    </button>
                    <button type="button" className="button" onClick={() => void merge()}>
                      <Combine size={15} />
                      Gabungkan jadi satu PDF
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="guide" aria-labelledby="guide-title">
        <h2 id="guide-title">Cara memakai</h2>
        <ol>
          <li>Pilih file dari perangkatmu, atau seret ke kotak di atas. Boleh lebih dari satu file.</li>
          <li>
            Klik <strong>Konversi ke PDF</strong>. Saat pertama kali, ada unduhan sekitar 50 MB untuk menyalakan mesin
            konversinya, jadi tunggu sebentar. Setelah itu jauh lebih cepat.
          </li>
          <li>
            Saat muncul <strong>PDF siap</strong>, klik <strong>Unduh</strong>. File tersimpan di folder Unduhan
            (Downloads) di perangkatmu.
          </li>
        </ol>

        <details>
          <summary>Apakah file saya aman?</summary>
          <p>
            Ya. File dibuka dan diubah oleh program yang berjalan di browser kamu sendiri, bukan di server. Tidak ada
            file yang dikirim ke mana pun. Kamu bisa membuktikannya: setelah satu konversi berhasil, matikan internet,
            lalu coba konversi lagi. Hasilnya tetap jadi.
          </p>
          <p>
            Kode situs ini terbuka dan bisa dilihat siapa saja di{' '}
            <a href="https://github.com/naufalraism/libre-convert" target="_blank" rel="noreferrer">
              GitHub
            </a>
            .
          </p>
        </details>

        <details>
          <summary>Kenapa hasilnya kadang sedikit berbeda dari Word?</summary>
          <p>
            Font yang tidak ada di perangkat diganti dengan font lain, sehingga letak teks bisa sedikit bergeser pada
            dokumen yang rumit. Untuk hasil paling mirip aslinya, biarkan tata letak halaman di <strong>Asli</strong>.
          </p>
          <p>Halaman ini memuat ulang satu kali saat pertama dibuka. Itu normal.</p>
        </details>
      </section>

      <footer className="credit">
        <p>
          Berdasarkan{' '}
          <a href="https://github.com/Rhgx/libre-convert" target="_blank" rel="noreferrer">
            Libre Convert
          </a>{' '}
          oleh Rhgx (lisensi MIT). Mesin konversi: LibreOffice melalui ZetaOffice.
        </p>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Lepaskan untuk menambah file</span>
        </div>
      )}
    </main>
  )
}

function statusText(job: Job, currentLayout: Layout): string {
  switch (job.status) {
    case 'queued':
      return ''
    case 'converting':
      return job.note ?? 'Mengonversi'
    case 'done': {
      const size = job.pdf ? `, ${formatBytes(job.pdf.size)}` : ''
      const madeLabel = LAYOUTS.find((item) => item.value === job.layout)?.label.toLowerCase()
      const made = job.layout && job.layout !== currentLayout && madeLabel ? ` (${madeLabel})` : ''
      return `PDF siap${size}${made}`
    }
    case 'error':
      return job.note ?? 'Konversi gagal'
  }
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}