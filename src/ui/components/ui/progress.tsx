import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/ui/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="me-auto h-full bg-primary transition-[width]"
        style={{ width: `${value || 0}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
