// Drag and drop is for a mouse, a trackpad or a pen. On a touch screen a
// finger on a list means scrolling, and a held finger means selecting
// text, so a drag there fights both. Touch gets menus instead: Move up,
// Move down, and Move to another week or module.

import { KeyboardSensor, PointerSensor, useSensor, useSensors, type KeyboardCoordinateGetter } from "@dnd-kit/core";

// A pointer sensor that only starts for a mouse or a pen.
class MouseOrPenSensor extends PointerSensor {
  static activators = [{
    eventName: "onPointerDown" as const,
    handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
      nativeEvent.pointerType !== "touch" && nativeEvent.isPrimary && nativeEvent.button === 0,
  }];
}

export function useDragSensors(coordinateGetter?: KeyboardCoordinateGetter) {
  return useSensors(
    useSensor(MouseOrPenSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, coordinateGetter ? { coordinateGetter } : undefined),
  );
}

// Whether this device is used by touch, so lists offer menus in place of dragging.
export const touchFirst = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
