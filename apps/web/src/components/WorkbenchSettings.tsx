import { Headset, Settings } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { QuestJoinPanel } from "@/components/QuestJoinPanel";
import { AboutSection } from "@/components/settings/AboutSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { VoiceSection } from "@/components/settings/VoiceSection";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { OPEN_QUEST_EVENT, OPEN_SETTINGS_EVENT } from "@/lib/command-palette";
import { cn } from "@/lib/utils";

type SettingsSectionId =
  | "appearance"
  | "voice"
  | "providers"
  | "shortcuts"
  | "about";

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-sm font-medium sm:sr-only">{children}</h2>;
}

export function WorkbenchSettings({ host }: { host: boolean }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [questOpen, setQuestOpen] = useState(false);
  const [pendingQuest, setPendingQuest] = useState(false);
  const [section, setSection] = useState<SettingsSectionId>("appearance");

  useEffect(() => {
    if (settingsOpen || !pendingQuest) return;
    setPendingQuest(false);
    setQuestOpen(true);
  }, [pendingQuest, settingsOpen]);

  useEffect(() => {
    const onSettings = () => {
      setSection("appearance");
      setSettingsOpen(true);
    };
    const onQuest = () => {
      if (!host) return;
      setPendingQuest(true);
      setSettingsOpen(false);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    window.addEventListener(OPEN_QUEST_EVENT, onQuest);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
      window.removeEventListener(OPEN_QUEST_EVENT, onQuest);
    };
  }, [host]);

  const sections: {
    id: SettingsSectionId;
    label: string;
    hostOnly?: boolean;
  }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "voice", label: "Voice", hostOnly: true },
    { id: "providers", label: "Providers" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "about", label: "About" },
  ];
  const visible = sections.filter((row) => (row.hostOnly ? host : true));

  const pane = (id: SettingsSectionId) => {
    const active = section === id;
    return cn(active ? "block" : "max-sm:block sm:hidden");
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <Dialog
            open={settingsOpen}
            onOpenChange={(open) => {
              setSettingsOpen(open);
              if (open) setSection("appearance");
            }}
          >
            <DialogTrigger render={<SidebarMenuButton />}>
              <Settings />
              Settings
            </DialogTrigger>
            <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] max-h-[min(40rem,calc(100dvh-2rem))] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-3 pr-10">
                <DialogTitle className="pr-0">Settings</DialogTitle>
              </div>
              <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                <nav
                  aria-label="Settings sections"
                  className="hidden shrink-0 flex-col gap-0.5 border-border p-2 sm:flex sm:w-44 sm:border-r"
                >
                  {visible.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      aria-current={section === row.id ? "page" : undefined}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        section === row.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/70"
                      )}
                      onClick={() => setSection(row.id)}
                    >
                      {row.label}
                    </button>
                  ))}
                </nav>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <section className={pane("appearance")}>
                    <SectionHeading>Appearance</SectionHeading>
                    <AppearanceSection />
                  </section>
                  {host ? (
                    <section className={cn("max-sm:mt-6", pane("voice"))}>
                      <SectionHeading>Voice</SectionHeading>
                      <VoiceSection />
                    </section>
                  ) : null}
                  <section className={cn("max-sm:mt-6", pane("providers"))}>
                    <SectionHeading>Providers</SectionHeading>
                    <ProvidersSection />
                  </section>
                  <section className={cn("max-sm:mt-6", pane("shortcuts"))}>
                    <SectionHeading>Shortcuts</SectionHeading>
                    <ShortcutsSection />
                  </section>
                  <section className={cn("max-sm:mt-6", pane("about"))}>
                    <SectionHeading>About</SectionHeading>
                    <AboutSection host={host} />
                  </section>
                </div>
              </div>
              {host ? (
                <div className="border-t border-border px-4 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => {
                      setPendingQuest(true);
                      setSettingsOpen(false);
                    }}
                  >
                    <Headset />
                    Enter Quest
                  </Button>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        </SidebarMenuItem>
      </SidebarMenu>
      {host ? (
        <QuestJoinPanel
          open={questOpen}
          onOpenChange={setQuestOpen}
          showTrigger={false}
        />
      ) : null}
    </>
  );
}
