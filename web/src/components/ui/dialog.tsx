import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "@/lib/utils"

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

const DialogTitle = DialogPrimitive.Title
const DialogDescription = DialogPrimitive.Description
const DialogClose = DialogPrimitive.Close

/** Centered sheet of paper over a soft ink scrim. `top` pins it near the top (command palette). */
function DialogContent({ className, top, ...props }: DialogPrimitive.Popup.Props & { top?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-150"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 rounded-2xl bg-popover text-popover-foreground shadow-float outline-none",
          top ? "top-[14vh]" : "top-1/2 -translate-y-1/2",
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-open:slide-in-from-top-1 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] duration-200",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  )
}

export { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose }
