import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"

// Every typed word must appear in the item (prefix of a word ranks higher). cmdk's default
// fuzzy subsequence match lets "pause" match nearly any long label.
function wordFilter(value: string, search: string, keywords?: string[]) {
  const hay = `${value} ${keywords?.join(" ") ?? ""}`.toLowerCase()
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every((w) => hay.includes(w))) return 0
  const tokens = hay.split(/[^a-z0-9]+/)
  return words.every((w) => tokens.some((t) => t.startsWith(w))) ? 1 : 0.5
}

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive filter={wordFilter} className={cn("flex w-full flex-col overflow-hidden text-ink", className)} {...props} />
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-hairline px-4">
      <Search className="size-4 shrink-0 text-faint" strokeWidth={1.75} />
      <CommandPrimitive.Input
        className={cn("h-12 w-full bg-transparent text-[14.5px] outline-none placeholder:text-faint", className)}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn(
        "max-h-[min(60vh,420px)] scroll-py-2 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin",
        "h-(--cmdk-list-height) transition-[height] duration-150 ease-out",
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-8 text-center text-[13px] text-muted-foreground" {...props} />
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "py-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] outline-none select-none",
        "data-[selected=true]:bg-selected data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40",
        "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("mx-2 my-1 h-px bg-hairline", className)} {...props} />
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[11px] text-faint", className)} {...props} />
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut }
