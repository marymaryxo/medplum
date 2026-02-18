// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Box, Button, Group, Menu, Modal, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { DateTimeInput } from '@medplum/react';
import { IconCalendarEvent, IconEye, IconTrash } from '@tabler/icons-react';
import { Calendar as ReactBigCalendar, dayjsLocalizer } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import type { Event, SlotInfo, ToolbarProps, View, EventProps } from 'react-big-calendar';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';
import type { Range } from '../types/scheduling';
import { getRecurrenceSeriesId } from '../utils/encounter';
import { SchedulingTransientIdentifier } from '../utils/scheduling';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault(dayjs.tz.guess());

const DnDCalendar = withDragAndDrop(ReactBigCalendar);

type AppointmentEvent = Event & { type: 'appointment'; appointment: Appointment; start: Date; end: Date; patientName: string; statusLabel: string };
type SlotEvent = Event & { type: 'slot'; slot: Slot; status: string; start: Date; end: Date };
type ScheduleEvent = AppointmentEvent | SlotEvent;

/** Availability range for a single time window (used to gray out non-working hours). */
export interface AvailabilityRange {
  start: Date;
  end: Date;
}

export const CalendarToolbar = (props: ToolbarProps<ScheduleEvent>): JSX.Element => {
  const [firstRender, setFirstRender] = useState(true);
  useEffect(() => {
    // The calendar does not provide any way to receive the range of dates that
    // are visible except when they change. This is the cleanest way I could find
    // to extend it to provide the _initial_ range (`onView` calls `onRangeChange`).
    // https://github.com/jquense/react-big-calendar/issues/1752#issuecomment-761051235
    if (firstRender) {
      props.onView(props.view);
      setFirstRender(false);
    }
  }, [props, firstRender, setFirstRender]);
  return (
    <Group justify="space-between" pb="sm">
      <Group>
        <Title order={3} mr="md">
          {props.view !== 'day' && dayjs(props.date).format('MMMM YYYY')}
          {props.view === 'day' && dayjs(props.date).format('MMMM D YYYY')}
        </Title>
        <Button.Group>
          <Button variant="default" size="sm" aria-label="Previous" onClick={() => props.onNavigate('PREV')}>
            <IconChevronLeft size={16} />
          </Button>
          <Button variant="default" size="sm" onClick={() => props.onNavigate('TODAY')}>
            Today
          </Button>
          <Button variant="default" size="sm" aria-label="Next" onClick={() => props.onNavigate('NEXT')}>
            <IconChevronRight size={16} />
          </Button>
        </Button.Group>
      </Group>
      <SegmentedControl
        size="sm"
        value={props.view}
        onChange={(newView) => props.onView(newView as View)}
        data={[
          { label: 'Month', value: 'month' },
          { label: 'Week', value: 'week' },
          { label: 'Day', value: 'day' },
        ]}
      />
    </Group>
  );
};

function appointmentsToEvents(appointments: Appointment[]): AppointmentEvent[] {
  return appointments
    .filter((appointment) => appointment.start && appointment.end)
    .map((appointment) => {
      // Find the patient among the participants to use as title
      const patientParticipant = appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'));
      const status = !['booked', 'arrived', 'fulfilled'].includes(appointment.status as string)
        ? ` (${appointment.status})`
        : '';

      const name = patientParticipant ? patientParticipant.actor?.display : 'No Patient';

      return {
        type: 'appointment',
        appointment,
        patientName: name ?? 'No Patient',
        statusLabel: status,
        title: `${name}${status}`,
        start: new Date(appointment.start as string),
        end: new Date(appointment.end as string),
        resource: appointment,
      };
    });
}

// This function collapses contiguous or overlapping slots of the same status into single events
function slotsToEvents(slots: Slot[]): SlotEvent[] {
  return slots.map((slot) => {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const durationHours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
    // Full-day blocks (23+ hrs) → all-day row, like Google Calendar
    const allDay = slot.status === 'busy-unavailable' && durationHours >= 23;
    return {
      type: 'slot',
      slot,
      status: slot.status,
      resource: slot,
      start,
      end,
      title: slot.status === 'free' ? 'Available' : (slot.comment || 'Blocked'),
      allDay,
    };
  });
}

function eventPropGetter(
  event: ScheduleEvent,
  _start: Date,
  _end: Date,
  _isSelected: boolean
): { className?: string | undefined; style?: React.CSSProperties } {
  if (event.type === 'slot' && event.status === 'busy-unavailable') {
    // Blocked slots: diagonal stripe pattern
    return {
      style: {
        background: 'repeating-linear-gradient(-45deg, #f1f3f5, #f1f3f5 4px, #e9ecef 4px, #e9ecef 8px)',
        color: '#495057',
        border: '1px solid #dee2e6',
        borderRadius: '4px',
        opacity: 0.9,
        fontSize: '0.75rem',
      },
    };
  }

  if (event.type === 'slot' && event.status === 'free') {
    // Available time: white overlay on the gray grid (working hours)
    // For $find transient slots, use a subtle green instead
    if (SchedulingTransientIdentifier.get(event.slot)) {
      return {
        style: {
          backgroundColor: '#d3f9d8',
          color: '#2b8a3e',
          border: '1px solid #b2f2bb',
          borderRadius: '4px',
          opacity: 0.85,
        },
      };
    }
    // Availability background: white with subtle horizontal lines
    return {
      style: {
        backgroundColor: '#ffffff',
        backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 39px, rgba(0,0,0,0.06) 39px, rgba(0,0,0,0.06) 40px)',
        border: 'none',
        borderRadius: '0',
        opacity: 1,
      },
    };
  }

  // Appointment events
  if (event.type === 'appointment') {
    const isCancelled = event.appointment.status === 'cancelled';
    const isFulfilled = event.appointment.status === 'fulfilled';
    // Cancelled and fulfilled (rescheduled/completed) stay visible but styled differently
    if (isCancelled) {
      return {
        style: {
          backgroundColor: '#e9ecef',
          borderLeft: '4px solid #868e96',
          borderTop: 'none',
          borderRight: 'none',
          borderBottom: 'none',
          borderRadius: '4px',
          color: '#495057',
          display: 'block',
          opacity: 0.9,
          textDecoration: 'line-through',
        },
      };
    }
    if (isFulfilled) {
      return {
        style: {
          backgroundColor: '#d3f9d8',
          borderLeft: '4px solid #2b8a3e',
          borderTop: 'none',
          borderRight: 'none',
          borderBottom: 'none',
          borderRadius: '4px',
          color: '#1a472a',
          display: 'block',
          opacity: 0.9,
        },
      };
    }
  }

  // Active appointments: blue with left accent border
  return {
    style: {
      backgroundColor: '#228be6',
      borderLeft: '4px solid #1971c2',
      borderTop: 'none',
      borderRight: 'none',
      borderBottom: 'none',
      borderRadius: '4px',
      color: 'white',
      display: 'block',
      opacity: 1.0,
    },
  };
}

/** Custom event rendering — name prominent for appointments, time secondary */
function CustomEvent({ event }: EventProps<ScheduleEvent>): JSX.Element {
  if (event.type === 'appointment') {
    const start = event.start;
    const end = event.end;
    const timeStr = `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return (
      <div style={{ lineHeight: 1.3, padding: '1px 0' }}>
        <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>
          {event.patientName}{event.statusLabel}
        </div>
        <div style={{ fontSize: '0.7rem', opacity: 0.85 }}>
          {timeStr}
        </div>
      </div>
    );
  }

  // Slot events (blocked / free)
  return (
    <div style={{ fontSize: '0.75rem', lineHeight: 1.3, padding: '1px 0' }}>
      {event.title}
    </div>
  );
}

const LONG_PRESS_MS = 500;

/** Wraps CustomEvent and adds right-click + long-press context menu for appointments */
function EventWithContextMenu(
  props: EventProps<ScheduleEvent> & {
    onContextMenu?: (e: React.MouseEvent, appointment: Appointment) => void;
  }
): JSX.Element {
  const { event, onContextMenu } = props;
  const content = <CustomEvent event={event} />;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!onContextMenu || event.type !== 'appointment' || event.appointment.status === 'cancelled') return;
      const touch = e.touches[0];
      if (touch) {
        const x = touch.clientX;
        const y = touch.clientY;
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          onContextMenu(
            { clientX: x, clientY: y, preventDefault: () => {} } as React.MouseEvent,
            event.appointment
          );
        }, LONG_PRESS_MS);
      }
    },
    [event, onContextMenu]
  );

  const handleTouchEnd = useCallback(() => clearLongPress(), [clearLongPress]);
  const handleTouchMove = useCallback(() => clearLongPress(), [clearLongPress]);

  if (event.type === 'appointment' && onContextMenu && event.appointment.status !== 'cancelled') {
    return (
      <div
        style={{ height: '100%', cursor: 'context-menu' }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, event.appointment);
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchCancel={handleTouchEnd}
      >
        {content}
      </div>
    );
  }

  return <>{content}</>;
}


export function Calendar(props: {
  slots: Slot[];
  appointments: Appointment[];
  availabilityRanges?: AvailabilityRange[];
  style?: React.CSSProperties;
  onSelectInterval?: (slotInfo: SlotInfo) => void;
  onSelectSlot?: (slot: Slot) => void;
  onSelectAppointment?: (appointment: Appointment) => void;
  onCancelAppointment?: (appointment: Appointment) => void | Promise<void>;
  onCancelSeries?: (appointment: Appointment) => void | Promise<void>;
  onRescheduleAppointment?: (appointment: Appointment, start: Date, end: Date) => void | Promise<void>;
  onRangeChange?: (range: Range) => void;
}): JSX.Element {
  const [view, setView] = useState<View>('week');
  const [date, setDate] = useState<Date>(new Date());
  const [range, setRange] = useState<Range | undefined>();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    appointment: Appointment;
  } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<{
    type: 'this' | 'series';
    appointment: Appointment;
  } | null>(null);
  const [rescheduleAppointment, setRescheduleAppointment] = useState<Appointment | null>(null);
  const [rescheduleStart, setRescheduleStart] = useState<Date | null>(null);
  const [rescheduleEnd, setRescheduleEnd] = useState<Date | null>(null);

  const { onRangeChange, onSelectAppointment, onSelectSlot, onCancelAppointment, onCancelSeries, onRescheduleAppointment } =
    props;
  const handleRangeChange = useCallback(
    (newRange: Date[] | { start: Date; end: Date }) => {
      let newStart: Date;
      let newEnd: Date;
      if (Array.isArray(newRange)) {
        // Week view passes the range as an array of dates
        newStart = newRange[0];
        newEnd = dayjs(newRange[newRange.length - 1])
          .add(1, 'day')
          .toDate();
      } else {
        // Other views pass the range as an object
        newStart = newRange.start;
        newEnd = newRange.end;
      }

      // Only update state if the range has changed
      if (newStart.getTime() !== range?.start.getTime() || newEnd.getTime() !== range.end.getTime()) {
        setRange({ start: newStart, end: newEnd });
        onRangeChange?.({ start: newStart, end: newEnd });
      }
    },
    [range, onRangeChange]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, appointment: Appointment) => {
    setContextMenu({ x: e.clientX, y: e.clientY, appointment });
  }, []);

  const handleSelectEvent = useCallback(
    (event: ScheduleEvent) => {
      if (event.type === 'appointment') {
        onSelectAppointment?.(event.appointment);
      } else if (event.type === 'slot') {
        onSelectSlot?.(event.slot);
      }
    },
    [onSelectAppointment, onSelectSlot]
  );

  const handleEventDrop = useCallback(
    ({ event, start, end }: { event: ScheduleEvent; start: Date; end: Date }) => {
      if (event.type === 'appointment' && onRescheduleAppointment) {
        onRescheduleAppointment(event.appointment, start, end);
      }
    },
    [onRescheduleAppointment]
  );

  const draggableAccessor = useCallback((event: ScheduleEvent) => {
    return event.type === 'appointment' && event.appointment.status !== 'cancelled' && !!event.appointment.id;
  }, []);

  // Foreground events: appointments + transient $find slots + clickable busy-unavailable slots with id
  // Appointments first so they render on top when overlapping; blocked slots behind
  const events = [
    ...slotsToEvents(props.slots.filter((slot) => !SchedulingTransientIdentifier.get(slot) && slot.id && slot.status === 'busy-unavailable')),
    ...slotsToEvents(props.slots.filter((slot) => SchedulingTransientIdentifier.get(slot))),
    ...appointmentsToEvents(props.appointments),
  ];

  // Background events: availability ranges shown as white overlays on the gray time grid.
  // The CSS sets the entire time grid to gray; white background events mark "working hours."
  const hasAvailability = (props.availabilityRanges ?? []).length > 0;
  const availabilityBgEvents: SlotEvent[] = useMemo(() => {
    if (!hasAvailability) {
      return [];
    }
    return (props.availabilityRanges ?? []).map((r, idx) => ({
      type: 'slot' as const,
      slot: { resourceType: 'Slot', schedule: { reference: '' }, status: 'free', start: r.start.toISOString(), end: r.end.toISOString() } as Slot,
      status: 'free',
      resource: {} as Slot,
      start: r.start,
      end: r.end,
      title: '',
    }));
  }, [props.availabilityRanges, hasAvailability]);

  const backgroundEvents = hasAvailability
    ? availabilityBgEvents
    : slotsToEvents(
        props.slots.filter((slot) => !SchedulingTransientIdentifier.get(slot) && !(slot.id && slot.status === 'busy-unavailable'))
      );

  const EventComponent = useCallback(
    (eventProps: EventProps<ScheduleEvent>) => (
      <EventWithContextMenu {...eventProps} onContextMenu={handleContextMenu} />
    ),
    [handleContextMenu]
  );

  return (
    <>
      <DnDCalendar
        components={{
          toolbar: CalendarToolbar,
          event: EventComponent as React.ComponentType<EventProps<ScheduleEvent>>,
        }}
      view={view}
      date={date}
      localizer={dayjsLocalizer(dayjs)}
      events={events}
      backgroundEvents={backgroundEvents}
      onNavigate={(newDate: Date, newView: View) => {
        setDate(newDate);
        setView(newView);
      }}
      onRangeChange={handleRangeChange}
      onSelectSlot={props.onSelectInterval}
      onSelectEvent={handleSelectEvent}
      onView={setView}
      onEventDrop={handleEventDrop}
      draggableAccessor={draggableAccessor}
      resizable={false}
      // Default scroll to current time
      scrollToTime={date}
      selectable
      eventPropGetter={eventPropGetter}
      style={props.style}
      dayLayoutAlgorithm="overlap"
      // ── Monday-first week ──
      culture="en-GB"
      />

      {contextMenu && (
        <Menu
          opened={!!contextMenu}
          onClose={() => setContextMenu(null)}
          position="bottom-start"
          shadow="md"
        >
          <Menu.Target>
            <Box
              style={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                width: 1,
                height: 1,
              }}
            />
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconEye size={16} />}
              onClick={() => {
                onSelectAppointment?.(contextMenu.appointment);
                setContextMenu(null);
              }}
            >
              View visit
            </Menu.Item>
            {onRescheduleAppointment && (
              <Menu.Item
                leftSection={<IconCalendarEvent size={16} />}
                onClick={() => {
                  const apt = contextMenu.appointment;
                  setRescheduleAppointment(apt);
                  setRescheduleStart(apt.start ? new Date(apt.start) : new Date());
                  setRescheduleEnd(apt.end ? new Date(apt.end) : new Date());
                  setContextMenu(null);
                }}
              >
                Reschedule
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconTrash size={16} />}
              color="red"
              onClick={() => {
                setConfirmCancel({ type: 'this', appointment: contextMenu.appointment });
                setContextMenu(null);
              }}
            >
              Cancel this appointment
            </Menu.Item>
            {getRecurrenceSeriesId(contextMenu.appointment) && (
              <Menu.Item
                leftSection={<IconTrash size={16} />}
                color="red"
                onClick={() => {
                  setConfirmCancel({ type: 'series', appointment: contextMenu.appointment });
                  setContextMenu(null);
                }}
              >
                Cancel entire series
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      )}

      <Modal
        opened={!!rescheduleAppointment}
        onClose={() => {
          setRescheduleAppointment(null);
          setRescheduleStart(null);
          setRescheduleEnd(null);
        }}
        title="Reschedule appointment"
        centered
      >
        {rescheduleAppointment && rescheduleStart && rescheduleEnd && (
          <Stack gap="md">
            <DateTimeInput
              name="reschedule-start"
              label="Start"
              value={rescheduleStart.toISOString()}
              onChange={(v) => setRescheduleStart(new Date(v))}
            />
            <DateTimeInput
              name="reschedule-end"
              label="End"
              value={rescheduleEnd.toISOString()}
              onChange={(v) => setRescheduleEnd(new Date(v))}
            />
            <Group justify="flex-end" gap="sm">
              <Button
                variant="subtle"
                onClick={() => {
                  setRescheduleAppointment(null);
                  setRescheduleStart(null);
                  setRescheduleEnd(null);
                }}
              >
                Cancel
              </Button>
              <Button
                leftSection={<IconCalendarEvent size={16} />}
                onClick={() => {
                  onRescheduleAppointment?.(rescheduleAppointment, rescheduleStart, rescheduleEnd);
                  setRescheduleAppointment(null);
                  setRescheduleStart(null);
                  setRescheduleEnd(null);
                }}
              >
                Reschedule
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={!!confirmCancel}
        onClose={() => setConfirmCancel(null)}
        title={confirmCancel?.type === 'series' ? 'Cancel entire series' : 'Cancel appointment'}
        centered
      >
        {confirmCancel && (
          <>
            <Text size="md" c="dimmed" mb="md">
              {confirmCancel.type === 'series'
                ? 'This will cancel all appointments in this recurring series. This action cannot be undone.'
                : 'Are you sure you want to cancel this appointment? This action cannot be undone.'}
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="subtle" onClick={() => setConfirmCancel(null)}>
                Keep
              </Button>
              <Button
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  if (confirmCancel.type === 'series') {
                    onCancelSeries?.(confirmCancel.appointment);
                  } else {
                    onCancelAppointment?.(confirmCancel.appointment);
                  }
                  setConfirmCancel(null);
                }}
              >
                {confirmCancel.type === 'series' ? 'Cancel entire series' : 'Cancel appointment'}
              </Button>
            </Group>
          </>
        )}
      </Modal>
    </>
  );
}
