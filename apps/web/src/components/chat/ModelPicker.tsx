import { ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  groupPickerModels,
  harnessStatusTitle,
  isModelFavorite,
  MODEL_FAVORITES_KEY,
  type ModelFavorite,
  mergeUnavailableSelection,
  modelDisplayName,
  pickerTriggerLabel,
  readModelFavorites,
  serializeModelFavorites,
  toggleModelFavorite,
} from "@/chat/model-picker";
import { ProviderLoginHint } from "@/components/chat/ProviderLoginHint";
import { ProviderMark } from "@/components/chat/ProviderMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { useHarnesses } from "@/hooks/useHarnesses";
import { HARNESS_IDS, HARNESS_LABEL, type HarnessId } from "@/lib/harness";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";

type HarnessCatalog = ReturnType<typeof useHarnesses>;

function ModelListSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-1">
      <Skeleton className="mb-1 h-3 w-16" />
      {Array.from({ length: 7 }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

function loadFavorites(): ModelFavorite[] {
  try {
    return readModelFavorites(localStorage.getItem(MODEL_FAVORITES_KEY));
  } catch {
    return [];
  }
}

function persistFavorites(next: ModelFavorite[]) {
  try {
    localStorage.setItem(MODEL_FAVORITES_KEY, serializeModelFavorites(next));
  } catch {
    /* quota / private mode */
  }
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "ready"
      ? "bg-emerald-500"
      : status === "needs-auth"
        ? "bg-amber-500"
        : status === "missing-cli"
          ? "bg-destructive"
          : "bg-muted-foreground";
  return (
    <span
      className={cn(
        "absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-1 ring-popover",
        tone
      )}
    />
  );
}

export function ModelPicker({ catalog }: { catalog: HarnessCatalog }) {
  const chatHarness = usePrefs((s) => s.chatHarness);
  const chatModel = usePrefs((s) => s.chatModel);
  const setChatSelection = usePrefs((s) => s.setChatSelection);
  const { harnesses, ready, error, refresh } = catalog;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<HarnessId>(chatHarness);
  const [favorites, setFavorites] = useState<ModelFavorite[]>(loadFavorites);

  useEffect(() => {
    if (open) setRail(chatHarness);
  }, [open, chatHarness]);

  const active = harnesses.find((h) => h.id === rail);
  const selectedHarness = harnesses.find((h) => h.id === chatHarness);
  const selectedModels = useMemo(
    () => mergeUnavailableSelection(selectedHarness?.models ?? [], chatModel),
    [selectedHarness, chatModel]
  );
  const selectedModel =
    selectedModels.find((m) => m.slug === chatModel) ?? null;
  const triggerName = selectedModel
    ? modelDisplayName(selectedModel)
    : `${chatModel.includes("/") ? chatModel.slice(chatModel.lastIndexOf("/") + 1) : chatModel} (unavailable)`;
  const triggerLabel = pickerTriggerLabel({
    harnessLabel: HARNESS_LABEL[chatHarness],
    model: selectedModel,
    slug: chatModel,
  });

  const groups = useMemo(() => {
    const models = mergeUnavailableSelection(
      active?.models ?? [],
      rail === chatHarness ? chatModel : null
    );
    return groupPickerModels({
      models,
      query,
      favoriteSlugs: favorites
        .filter((row) => row.harness === rail)
        .map((row) => row.model),
      defaultGroup: active?.label ?? "",
    });
  }, [active, chatHarness, chatModel, favorites, query, rail]);

  const catalogPending = !ready && harnesses.length === 0;
  const notReady = active != null && active.status !== "ready";

  const star = (slug: string) => {
    const next = toggleModelFavorite(favorites, rail, slug);
    persistFavorites(next);
    setFavorites(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh("open");
        else setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 max-w-[5.5rem] min-w-0 shrink gap-1.5 px-1.5 text-xs font-normal text-muted-foreground @[360px]/chat:max-w-32"
            title={triggerLabel}
            aria-label={triggerLabel}
          />
        }
      >
        <ProviderMark id={chatHarness} />
        <span className="min-w-0 truncate">{triggerName}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        data-model-picker-content
        className="flex h-72 w-80 gap-1 overflow-hidden overscroll-contain p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex w-10 shrink-0 flex-col gap-0.5 border-r border-border pr-1">
          {HARNESS_IDS.map((id) => {
            const info = harnesses.find((h) => h.id === id);
            const railTitle = info
              ? harnessStatusTitle(HARNESS_LABEL[id], info.status)
              : HARNESS_LABEL[id];
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="icon-sm"
                title={railTitle}
                aria-label={railTitle}
                className={cn("relative size-9", rail === id && "bg-accent")}
                onClick={() => {
                  setRail(id);
                  setQuery("");
                }}
              >
                <ProviderMark id={id} className="size-5" />
                {info ? <StatusDot status={info.status} /> : null}
              </Button>
            );
          })}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overscroll-contain">
          <Input
            className="mb-1 h-7 text-xs"
            placeholder="Search models…"
            aria-label="Search models"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {catalogPending ? (
              <ModelListSkeleton />
            ) : error ? (
              <div className="flex flex-col gap-1.5 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">
                  Couldn’t load models
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 self-start px-2 text-xs"
                  onClick={() => refresh("retry")}
                >
                  Check again
                </Button>
              </div>
            ) : notReady && active ? (
              <div className="px-2 py-1.5">
                <ProviderLoginHint
                  info={active}
                  onCheckAgain={() => refresh("retry")}
                />
              </div>
            ) : groups.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No matches
              </div>
            ) : (
              <ul>
                {groups.map(({ group, models }) => (
                  <li key={group} className="mb-1">
                    {group ? (
                      <div
                        className={cn(
                          "px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground",
                          group === "Favorites" ? undefined : "uppercase"
                        )}
                      >
                        {group}
                      </div>
                    ) : null}
                    {models.map((m) => {
                      const selected =
                        rail === chatHarness && m.slug === chatModel;
                      const favorite = isModelFavorite(favorites, rail, m.slug);
                      return (
                        <div
                          key={m.slug}
                          className={cn(
                            "flex w-full items-center rounded-sm",
                            selected
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent"
                          )}
                        >
                          <PopoverClose
                            className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                            onClick={() => setChatSelection(rail, m.slug)}
                          >
                            {modelDisplayName(m)}
                          </PopoverClose>
                          <button
                            type="button"
                            className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                            aria-label={
                              favorite
                                ? "Remove from favorites"
                                : "Add to favorites"
                            }
                            aria-pressed={favorite}
                            title={
                              favorite
                                ? "Remove from favorites"
                                : "Add to favorites"
                            }
                            onClick={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              star(m.slug);
                            }}
                          >
                            <Star
                              className={cn(
                                "size-3",
                                favorite && "fill-current text-foreground"
                              )}
                            />
                          </button>
                        </div>
                      );
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
