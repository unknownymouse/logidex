import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Film, Image as ImageIcon, Move, Sparkles, Users } from 'lucide-react'
import {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  DEFAULT_ANTIGRAVITY_IMAGE_MODEL,
  DEFAULT_ANTIGRAVITY_VIDEO_MODEL
} from '@shared/antigravity'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  effectiveResolution,
  fitDuration,
  getImageModel,
  getVideoModel,
  hfModelOptions,
  maxRefs,
  resolutionOptions
} from '@shared/higgsfield'
import type { CreditEstimate, ImageProvider, ModelOption, Project, VideoProvider } from '@shared/types'
import { ModelLogo } from '../../components/ModelLogo'
import { ModelPicker } from '../../components/ModelPicker'
import { Segmented, Spinner } from '../../components/ui'
import { creditLabel } from '../../lib/format'
import { useEstimate, useEstimates } from '../../lib/useEstimate'

const IMAGE_OPTIONS = hfModelOptions('image')
const VIDEO_OPTIONS = hfModelOptions('video')
const IMAGE_IDS = IMAGE_OPTIONS.map((o) => o.id)
const VIDEO_IDS = VIDEO_OPTIONS.map((o) => o.id)

/** Adds each model's estimated credits to its picker row once a Higgsfield key is known to exist. */
function withCosts(options: ModelOption[], costs: Record<string, CreditEstimate | null>, unit: (id: string) => string, on: boolean): ModelOption[] {
  if (!on) return options
  return options.map((o) => ({
    ...o,
    credits: o.id in costs ? (costs[o.id]?.credits ?? null) : undefined,
    usd: costs[o.id]?.usd ?? null,
    creditUnit: unit(o.id)
  }))
}

function Cost({
  value,
  hasKey,
  children
}: {
  value: CreditEstimate | null | undefined
  hasKey: boolean | null
  children: (credits: number) => ReactNode
}) {
  if (hasKey === false) return <span className="text-muted">Perkiraan kredit muncul setelah kunci Higgsfield diisi di Pengaturan.</span>
  if (value === undefined)
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <Spinner className="size-3" />
        Menghitung kredit…
      </span>
    )
  if (value === null) return <span className="text-muted">Perkiraan kredit belum tersedia.</span>
  return <span>{children(value.credits)}</span>
}

function Card({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line-2 bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
          {icon}
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  )
}

/** Which models draw and animate this project's clips (Higgsfield or Antigravity). */
export function ModelSection({
  project,
  clipCount,
  perClip,
  onChange
}: {
  project: Project
  clipCount: number
  perClip: number
  onChange: (patch: {
    imageProvider?: ImageProvider
    videoProvider?: VideoProvider
    imageModel?: string
    videoModel?: string
    videoResolution?: string | null
  }) => void
}) {
  const imageProvider = project.imageProvider ?? 'higgsfield'
  const videoProvider = project.videoProvider ?? 'higgsfield'

  const image = getImageModel(project.imageModel)
  const video = getVideoModel(project.videoModel)
  const seconds = fitDuration(video, perClip) ?? perClip
  const imageCost = useEstimate('image', image.id, project.aspectRatio)
  const resolutions = resolutionOptions(video)
  const resolution = effectiveResolution(video, project.videoResolution)
  const videoCost = useEstimate('video', video.id, project.aspectRatio, perClip, resolution)

  const [hasHfKey, setHasHfKey] = useState<boolean | null>(null)
  const [hasAgKey, setHasAgKey] = useState<boolean | null>(null)

  useEffect(() => {
    void window.api.settings.keys().then((keys) => {
      setHasHfKey(!!keys.find((k) => k.provider === 'higgsfield')?.configured)
      setHasAgKey(!!keys.find((k) => k.provider === 'antigravity')?.configured)
    })
  }, [])

  const imageCosts = useEstimates('image', IMAGE_IDS, project.aspectRatio, undefined, hasHfKey === true)
  const videoCosts = useEstimates('video', VIDEO_IDS, project.aspectRatio, perClip, hasHfKey === true)
  const imageModels = useMemo(() => withCosts(IMAGE_OPTIONS, imageCosts, () => '', hasHfKey === true), [imageCosts, hasHfKey])
  const videoModels = useMemo(
    () => withCosts(VIDEO_OPTIONS, videoCosts, (id) => `${fitDuration(getVideoModel(id), perClip)} dtk`, hasHfKey === true),
    [videoCosts, perClip, hasHfKey]
  )

  const agImageModel = ANTIGRAVITY_IMAGE_MODELS.find((m) => m.id === project.imageModel) ?? ANTIGRAVITY_IMAGE_MODELS[0]
  const agVideoModel = ANTIGRAVITY_VIDEO_MODELS.find((m) => m.id === project.videoModel) ?? ANTIGRAVITY_VIDEO_MODELS[0]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">Model AI</span>
        <span className="text-[13px] text-muted">Pilih penyedia dan model untuk gambar klip dan video AI</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card
          icon={<ImageIcon className="size-4" />}
          title="Gambar klip"
          action={
            <Segmented
              size="sm"
              value={imageProvider}
              onChange={(p) =>
                onChange({
                  imageProvider: p as ImageProvider,
                  imageModel: p === 'antigravity' ? DEFAULT_ANTIGRAVITY_IMAGE_MODEL : DEFAULT_IMAGE_MODEL
                })
              }
              options={[
                { id: 'higgsfield', label: 'Higgsfield' },
                { id: 'antigravity', label: 'Antigravity' }
              ]}
            />
          }
        >
          {imageProvider === 'antigravity' ? (
            <>
              <ModelPicker
                value={agImageModel.id}
                models={ANTIGRAVITY_IMAGE_MODELS}
                renderIcon={(m) => <ModelLogo family={m.family} />}
                detail="description"
                menuClassName="w-[430px]"
                onChange={(id) => onChange({ imageModel: id })}
              />
              <p className="flex items-center gap-1.5 text-[12.5px] leading-snug text-ink-2">
                <Sparkles className="size-3.5 text-accent" />
                <span>Imagen 3 melalui Antigravity Auth relay · Bebas kredit Higgsfield</span>
              </p>
              <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
                {hasAgKey === false
                  ? 'Proxy Antigravity belum terhubung. Atur di Pengaturan.'
                  : 'Wajah dan kostum karakter dibuat konsisten berdasarkan deskripsi naskah.'}
              </p>
            </>
          ) : (
            <>
              <ModelPicker
                value={image.id}
                models={imageModels}
                footerNote={hasHfKey ? 'kredit per gambar, perkiraan Higgsfield untuk akunmu' : undefined}
                renderIcon={(m) => <ModelLogo family={m.family} />}
                detail="description"
                tagFilters={['Rekomendasi', 'Referensi', 'GPT Image', 'Soul', 'Recraft', '4K']}
                menuClassName="w-[430px]"
                onChange={(id) => onChange({ imageModel: id })}
              />
              <p className="text-[12.5px] leading-snug text-ink-2">
                <Cost value={imageCost} hasKey={hasHfKey}>
                  {(c) => (
                    <>
                      ≈ {creditLabel(c)} kredit per gambar · {clipCount} gambar ≈{' '}
                      <b className="font-semibold text-ink">{creditLabel(c * clipCount)} kredit</b>
                    </>
                  )}
                </Cost>
              </p>
              <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
                <Users className="mt-px size-3.5 shrink-0" />
                {maxRefs(image)
                  ? 'Pakai lembar karakter, jadi wajah dan kostum tokoh tetap sama di tiap klip.'
                  : 'Tanpa lembar karakter, jadi tampilan tokoh bisa sedikit berubah antar klip.'}
              </p>
            </>
          )}
        </Card>

        <Card
          icon={<Film className="size-4" />}
          title="Video AI"
          action={
            <Segmented
              size="sm"
              value={videoProvider}
              onChange={(p) =>
                onChange({
                  videoProvider: p as VideoProvider,
                  videoModel: p === 'antigravity' ? DEFAULT_ANTIGRAVITY_VIDEO_MODEL : DEFAULT_VIDEO_MODEL
                })
              }
              options={[
                { id: 'higgsfield', label: 'Higgsfield' },
                { id: 'antigravity', label: 'Antigravity' }
              ]}
            />
          }
        >
          {videoProvider === 'antigravity' ? (
            <>
              <ModelPicker
                value={agVideoModel.id}
                models={ANTIGRAVITY_VIDEO_MODELS}
                renderIcon={(m) => <ModelLogo family={m.family} />}
                detail="description"
                align="right"
                menuClassName="w-[430px]"
                onChange={(id) => onChange({ videoModel: id })}
              />
              <p className="flex items-center gap-1.5 text-[12.5px] leading-snug text-ink-2">
                <Sparkles className="size-3.5 text-accent" />
                <span>Veo 2 (Image-to-Video) melalui Antigravity Auth relay · Bebas kredit Higgsfield</span>
              </p>
              <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
                <Move className="mt-px size-3.5 shrink-0" />
                Hanya untuk klip yang kamu jadikan Video AI. Gerak kamera tetap gratis.
              </p>
            </>
          ) : (
            <>
              <ModelPicker
                value={video.id}
                models={videoModels}
                footerNote={hasHfKey ? `kredit per video untuk klip ±${perClip} detik` : undefined}
                renderIcon={(m) => <ModelLogo family={m.family} />}
                detail="description"
                tagFilters={['Rekomendasi', 'Kling', 'Seedance', 'Wan', 'Referensi', '4K']}
                align="right"
                menuClassName="w-[430px]"
                onChange={(id) => onChange({ videoModel: id })}
              />
              {resolutions.length > 1 ? (
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0 text-[12.5px] font-medium text-ink-2">Resolusi</span>
                  <Segmented
                    size="sm"
                    value={resolution ?? resolutions[0]}
                    onChange={(v) => onChange({ videoResolution: v })}
                    options={resolutions.map((r) => ({
                      id: r,
                      label: r.toUpperCase() === '4K' || r.toUpperCase() === '2K' ? r.toUpperCase() : r
                    }))}
                    className="min-w-0 flex-1"
                  />
                </div>
              ) : (
                resolution && <p className="text-[12.5px] text-ink-2">Resolusi {resolution} (satu-satunya pilihan model ini)</p>
              )}
              <p className="text-[12.5px] leading-snug text-ink-2">
                <Cost value={videoCost} hasKey={hasHfKey}>
                  {(c) => (
                    <>
                      ≈ {creditLabel(c)} kredit per video {seconds} detik{resolution ? `, ${resolution}` : ''}
                    </>
                  )}
                </Cost>
              </p>
              <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
                <Move className="mt-px size-3.5 shrink-0" />
                Hanya untuk klip yang kamu jadikan Video AI. Gerak kamera tetap gratis.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
