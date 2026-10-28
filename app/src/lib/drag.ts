// Drag and drop is for a mouse, a trackpad or a pen. On a touch screen a
// finger on a list means scrolling, and a held finger means selecting
// text, so a drag there fights both. Touch and the keyboard get menus
// instead: Move up, Move down, and Move to another week or module.
//
// There is no dragging by keyboard. The rows hold fields, such as Edit
// details, and a keyboard drag starts on Space or Enter pressed anywhere in
// a row, so a space typed in a title picked the reading up instead.

import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";

// A pointer sensor that only starts for a mouse or a pen.
class MouseOrPenSensor extends PointerSensor {
  static activators = [{
    eventName: "onPointerDown" as const,
    handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
      nativeEvent.pointerType !== "touch" && nativeEvent.isPrimary && nativeEvent.button === 0,
  }];
}

export function useDragSensors() {
  return useSensors(useSensor(MouseOrPenSensor, { activationConstraint: { distance: 6 } }));
}
