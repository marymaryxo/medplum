# Complete FHIR Provider Availability Capabilities

This document provides a comprehensive overview of all FHIR capabilities for providers to set and manage their availability.

---

## 📋 Table of Contents

1. [Core FHIR Resources](#core-fhir-resources)
2. [Availability Configuration Capabilities](#availability-configuration-capabilities)
3. [FHIR Operations](#fhir-operations)
4. [Slot Status Management](#slot-status-management)
5. [Multi-Resource Coordination](#multi-resource-coordination)
6. [Complete Example Scenarios](#complete-example-scenarios)

---

## 🏗️ Core FHIR Resources

### Resource Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    FHIR Scheduling Resources                │
└─────────────────────────────────────────────────────────────┘

ActivityDefinition (Service-level defaults)
    │
    ├─ Defines default scheduling parameters for service types
    ├─ Shared across multiple providers
    └─ Referenced by Schedule.serviceType codes

Schedule (Actor-level availability)
    │
    ├─ One Schedule per Practitioner/Location/Device
    ├─ Contains SchedulingParameters extension
    ├─ Can override ActivityDefinition defaults
    └─ Links to Slots

Slot (Time blocks)
    │
    ├─ Created on-demand (not pre-generated)
    ├─ Represents booked time or blocked time
    └─ Links to Appointments

Appointment (Booked appointments)
    │
    ├─ Represents confirmed bookings
    ├─ Links to Slots
    └─ Can result in Encounters
```

### Resource Relationships

| Resource | Purpose | Key Fields |
|----------|---------|------------|
| **ActivityDefinition** | Defines appointment types and default constraints | `code`, `extension[SchedulingParameters]` |
| **Schedule** | Represents provider/room/device availability | `actor`, `serviceType`, `extension[SchedulingParameters]` |
| **Slot** | Specific time blocks (created on-demand) | `schedule`, `status`, `start`, `end`, `serviceType` |
| **Appointment** | Booked appointment | `status`, `slot`, `participant`, `serviceType` |

---

## ⚙️ Availability Configuration Capabilities

### SchedulingParameters Extension - Complete Field Reference

All availability configuration is managed through the `SchedulingParameters` extension (`https://medplum.com/fhir/StructureDefinition/SchedulingParameters`).

#### Field Reference Table

| Field | Type | Applies To | Required | Description | Example |
|-------|------|------------|-----------|-------------|---------|
| **`availability`** | Timing | Schedule only | Optional | Recurring time windows when provider is available | Mon-Fri 9am-5pm |
| **`duration`** | Duration | Both | **Required** | Length of appointment slots | 30 minutes, 1 hour |
| **`bufferBefore`** | Duration | Both | Optional | Prep time required before appointment | 5 minutes |
| **`bufferAfter`** | Duration | Both | Optional | Cleanup time required after appointment | 10 minutes |
| **`alignmentInterval`** | Duration | Both | Optional | Time grid alignment (e.g., every 15 min) | 15 minutes |
| **`alignmentOffset`** | Duration | Both | Optional* | Shift from interval boundaries | 5 minutes offset |
| **`bookingLimit`** | Timing | Both | Optional | Max appointments per period (can have multiple) | 8 per day, 3 per week |
| **`serviceType`** | CodeableConcept | Schedule only | Optional | Service-specific override | "new-patient-visit" |
| **`timezone`** | Code | Schedule only | Optional | IANA timezone identifier | "America/New_York" |

*`alignmentOffset` requires `alignmentInterval` to be defined

---

## 🎯 Detailed Capability Breakdown

### 1. **Recurring Availability Patterns**

Providers can define availability using recurring patterns:

```json
{
  "url": "availability",
  "valueTiming": {
    "repeat": {
      "dayOfWeek": ["mon", "tue", "wed", "thu", "fri"],
      "timeOfDay": ["09:00:00"],
      "duration": 8,
      "durationUnit": "h"
    }
  }
}
```

**Capabilities:**
- ✅ Multiple days of week
- ✅ Multiple time windows per day
- ✅ Duration specification (hours, minutes, days, weeks)
- ✅ Timezone-aware scheduling

**Example Patterns:**
- Standard work week: Mon-Fri 9am-5pm
- Split shifts: Mon-Fri 9am-12pm, 2pm-5pm
- Weekend availability: Sat-Sun 10am-2pm
- Extended hours: Mon-Wed 7am-7pm

---

### 2. **Service Type-Specific Availability**

Providers can set different availability for different service types:

```json
{
  "extension": [
    {
      "url": "SchedulingParameters",
      "extension": [
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["mon", "tue", "wed", "thu", "fri"],
              "timeOfDay": ["09:00:00"],
              "duration": 8,
              "durationUnit": "h"
            }
          }
        }
      ]
    },
    {
      "url": "SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "new-patient-visit"}]
          }
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["tue", "thu"],
              "timeOfDay": ["09:00:00"],
              "duration": 4,
              "durationUnit": "h"
            }
          }
        }
      ]
    }
  ]
}
```

**Use Cases:**
- New patient visits: Only Tue/Thu mornings
- Follow-ups: Available Mon-Fri all day
- Procedures: Only Wed/Fri afternoons
- Consultations: Mon/Wed/Fri mornings

---

### 3. **Time Grid Alignment**

Control when appointments can start:

```json
{
  "url": "alignmentInterval",
  "valueDuration": {
    "value": 15,
    "unit": "min"
  }
}
```

**Capabilities:**
- ✅ Fixed intervals (every 15, 30, 60 minutes)
- ✅ Custom offsets from hour boundaries
- ✅ Flexible start times (no alignment)

**Examples:**
- Every 15 minutes: `:00, :15, :30, :45`
- Every 30 minutes with 5-min offset: `:05, :35`
- Hourly: `:00` only
- No alignment: Any time within availability window

---

### 4. **Buffer Times**

Require free time before/after appointments:

```json
{
  "url": "bufferBefore",
  "valueDuration": {
    "value": 15,
    "unit": "min"
  },
  "url": "bufferAfter",
  "valueDuration": {
    "value": 10,
    "unit": "min"
  }
}
```

**Use Cases:**
- Prep time for procedures
- Cleanup time after appointments
- Travel time between locations
- Documentation time

---

### 5. **Booking Limits**

Cap the number of appointments per time period:

```json
{
  "url": "bookingLimit",
  "valueTiming": {
    "repeat": {
      "frequency": 8,
      "period": 1,
      "periodUnit": "d"
    }
  }
}
```

**Capabilities:**
- ✅ Multiple limits (e.g., 8 per day AND 3 per week)
- ✅ Different limits per service type
- ✅ Daily, weekly, monthly limits

**Examples:**
- Max 8 appointments per day
- Max 3 new patient visits per week
- Max 2 procedures per day
- Max 20 appointments per month

---

### 6. **Timezone Support**

Specify timezone for availability interpretation:

```json
{
  "url": "timezone",
  "valueCode": "America/Los_Angeles"
}
```

**Capabilities:**
- ✅ Per-service-type timezones
- ✅ Falls back to actor timezone if not specified
- ✅ IANA timezone identifiers
- ✅ Multi-timezone providers

**Use Cases:**
- Provider works in multiple timezones
- Remote consultations across timezones
- Traveling providers

---

### 7. **Blocking Time**

Mark specific time periods as unavailable:

```json
{
  "resourceType": "Slot",
  "schedule": {"reference": "Schedule/dr-smith-schedule"},
  "status": "busy-unavailable",
  "start": "2025-12-24T08:00:00Z",
  "end": "2025-12-27T07:59:59Z",
  "comment": "Holiday vacation",
  "serviceType": [{"coding": [{"code": "office-visit"}]}]
}
```

**Capabilities:**
- ✅ Block all services (no serviceType)
- ✅ Block specific service types only
- ✅ Temporary blocks (vacations, holidays)
- ✅ Permanent blocks (lunch breaks, admin time)

---

## 🔧 FHIR Operations

### 1. **$find** - Find Available Slots

**Status:** ✅ Alpha (January 2026)

**Endpoint:** `POST /Schedule/{id}/$find`

**Parameters:**
- `start` (dateTime, required): Start of search window
- `end` (dateTime, required): End of search window
- `service-type` (string, optional): Filter by service type

**Returns:** Bundle of available Slot resources

**Example:**
```json
POST /Schedule/dr-smith-schedule/$find
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "start",
      "valueDateTime": "2025-02-15T09:00:00Z"
    },
    {
      "name": "end",
      "valueDateTime": "2025-02-15T17:00:00Z"
    },
    {
      "name": "service-type",
      "valueString": "office-visit"
    }
  ]
}
```

**Current Limitations:**
- Supports only a single Schedule
- Does not yet use ActivityDefinition default service type parameters

---

### 2. **$hold** - Temporarily Hold a Slot

**Status:** 🚧 In Development (Coming Soon)

**Purpose:** Reserve a slot temporarily while patient completes booking

**Use Cases:**
- Hold slot during checkout process
- Prevent double-booking during booking flow
- Temporary reservations

---

### 3. **$book** - Book an Appointment

**Status:** 🚧 In Development (Coming Soon)

**Purpose:** Create Appointment and associated Slot resources

**Capabilities:**
- ✅ Multi-resource booking (surgeon + OR + anesthesiologist)
- ✅ Transaction bundles for atomicity
- ✅ Conflict detection
- ✅ Validation against availability rules

**Example:**
```json
POST /Appointment/$book
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "slot",
      "resource": {
        "resourceType": "Slot",
        "schedule": {"reference": "Schedule/surgeon-schedule"},
        "start": "2025-02-15T10:00:00Z",
        "end": "2025-02-15T11:00:00Z"
      }
    },
    {
      "name": "slot",
      "resource": {
        "resourceType": "Slot",
        "schedule": {"reference": "Schedule/or-room-3"},
        "start": "2025-02-15T10:00:00Z",
        "end": "2025-02-15T11:00:00Z"
      }
    }
  ]
}
```

---

### 4. **$cancel** - Cancel an Appointment

**Status:** 🚧 In Development (Coming Soon)

**Purpose:** Cancel an appointment and free up associated Slots

**Capabilities:**
- ✅ Release Slot resources
- ✅ Update Appointment status
- ✅ Handle cancellation reasons
- ✅ Notify participants

---

## 📊 Slot Status Management

### Slot Status Values

| Status | Meaning | Use Case |
|--------|---------|----------|
| **`free`** | Available for booking | Default state |
| **`busy`** | Booked/occupied | Active appointment |
| **`busy-unavailable`** | Blocked/unavailable | Vacation, holiday, blocked time |
| **`busy-tentative`** | Tentatively booked | Pending confirmation |
| **`entered-in-error`** | Error state | Correction needed |

### Slot Lifecycle

```
┌─────────┐
│  FREE   │  ← Default (implicit availability)
└────┬────┘
     │
     ├─→ [Booking] ─→ ┌─────────┐
     │                │  BUSY   │  ← Booked appointment
     │                └────┬────┘
     │                     │
     │                     └─→ [Cancel] ─→ ┌─────────┐
     │                                      │  FREE   │
     │                                      └─────────┘
     │
     └─→ [Block Time] ─→ ┌──────────────────┐
                        │ BUSY-UNAVAILABLE │  ← Vacation/holiday
                        └──────────────────┘
```

---

## 🔗 Multi-Resource Coordination

### Complex Scheduling Scenarios

Providers can coordinate multiple resources for complex procedures:

**Example: Bariatric Surgery**
- Surgeon Schedule
- Operating Room Schedule
- Anesthesiologist Schedule
- Recovery Room Schedule

**Coordination:**
- All resources must be available simultaneously
- Transaction bundles ensure atomicity
- Intersection of availability windows
- Shared constraints (buffers, alignment)

**Implementation:**
```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "resource": {
        "resourceType": "Slot",
        "schedule": {"reference": "Schedule/surgeon"},
        "status": "busy",
        "start": "2025-02-15T10:00:00Z",
        "end": "2025-02-15T12:00:00Z"
      }
    },
    {
      "resource": {
        "resourceType": "Slot",
        "schedule": {"reference": "Schedule/or-room-3"},
        "status": "busy",
        "start": "2025-02-15T10:00:00Z",
        "end": "2025-02-15T12:00:00Z"
      }
    },
    {
      "resource": {
        "resourceType": "Appointment",
        "status": "booked",
        "serviceType": [{"coding": [{"code": "bariatric-surgery"}]}],
        "slot": [
          {"reference": "Slot/surgeon-slot"},
          {"reference": "Slot/or-slot"}
        ]
      }
    }
  ]
}
```

---

## 🎬 Complete Example Scenarios

### Scenario 1: Primary Care Provider

**Requirements:**
- Standard office hours: Mon-Fri 9am-5pm
- 30-minute appointments
- 5-minute buffers
- 15-minute alignment intervals
- Max 16 appointments per day

**Configuration:**
```json
{
  "resourceType": "Schedule",
  "id": "dr-johnson-schedule",
  "actor": [{"reference": "Practitioner/dr-johnson"}],
  "extension": [{
    "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
    "extension": [
      {
        "url": "duration",
        "valueDuration": {"value": 30, "unit": "min"}
      },
      {
        "url": "availability",
        "valueTiming": {
          "repeat": {
            "dayOfWeek": ["mon", "tue", "wed", "thu", "fri"],
            "timeOfDay": ["09:00:00"],
            "duration": 8,
            "durationUnit": "h"
          }
        }
      },
      {
        "url": "bufferBefore",
        "valueDuration": {"value": 5, "unit": "min"}
      },
      {
        "url": "bufferAfter",
        "valueDuration": {"value": 5, "unit": "min"}
      },
      {
        "url": "alignmentInterval",
        "valueDuration": {"value": 15, "unit": "min"}
      },
      {
        "url": "bookingLimit",
        "valueTiming": {
          "repeat": {
            "frequency": 16,
            "period": 1,
            "periodUnit": "d"
          }
        }
      }
    ]
  }]
}
```

**Result:**
- Available slots: Every 15 minutes from 9:00am to 4:45pm
- Each slot: 30 minutes + 5 min buffer before + 5 min buffer after = 40 minutes total
- Max 16 appointments per day

---

### Scenario 2: Multi-Service Specialist

**Requirements:**
- General availability: Mon-Fri 9am-5pm
- New patient visits: Tue/Thu 9am-1pm only (60 min, max 3/day)
- Follow-ups: Mon-Fri 9am-5pm (20 min, max 20/day)
- Procedures: Wed/Fri 2pm-5pm (90 min, max 2/day)

**Configuration:**
```json
{
  "resourceType": "Schedule",
  "id": "dr-chen-schedule",
  "actor": [{"reference": "Practitioner/dr-chen"}],
  "serviceType": [
    {"coding": [{"code": "new-patient-visit"}]},
    {"coding": [{"code": "follow-up"}]},
    {"coding": [{"code": "procedure"}]}
  ],
  "extension": [
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "duration",
          "valueDuration": {"value": 1, "unit": "h"}
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["mon", "tue", "wed", "thu", "fri"],
              "timeOfDay": ["09:00:00"],
              "duration": 8,
              "durationUnit": "h"
            }
          }
        }
      ]
    },
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "new-patient-visit"}]
          }
        },
        {
          "url": "duration",
          "valueDuration": {"value": 60, "unit": "min"}
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["tue", "thu"],
              "timeOfDay": ["09:00:00"],
              "duration": 4,
              "durationUnit": "h"
            }
          }
        },
        {
          "url": "bookingLimit",
          "valueTiming": {
            "repeat": {
              "frequency": 3,
              "period": 1,
              "periodUnit": "d"
            }
          }
        }
      ]
    },
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "follow-up"}]
          }
        },
        {
          "url": "duration",
          "valueDuration": {"value": 20, "unit": "min"}
        },
        {
          "url": "alignmentInterval",
          "valueDuration": {"value": 10, "unit": "min"}
        },
        {
          "url": "bookingLimit",
          "valueTiming": {
            "repeat": {
              "frequency": 20,
              "period": 1,
              "periodUnit": "d"
            }
          }
        }
      ]
    },
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "procedure"}]
          }
        },
        {
          "url": "duration",
          "valueDuration": {"value": 90, "unit": "min"}
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["wed", "fri"],
              "timeOfDay": ["14:00:00"],
              "duration": 3,
              "durationUnit": "h"
            }
          }
        },
        {
          "url": "bufferBefore",
          "valueDuration": {"value": 30, "unit": "min"}
        },
        {
          "url": "bufferAfter",
          "valueDuration": {"value": 15, "unit": "min"}
        },
        {
          "url": "bookingLimit",
          "valueTiming": {
            "repeat": {
              "frequency": 2,
              "period": 1,
              "periodUnit": "d"
            }
          }
        }
      ]
    }
  ]
}
```

---

### Scenario 3: Multi-Timezone Provider

**Requirements:**
- Cardiac surgery: Mon-Wed 11am-3pm (Pacific Time)
- Call center: Mon-Wed 9am-5pm (Eastern Time)

**Configuration:**
```json
{
  "resourceType": "Schedule",
  "id": "dr-smith-schedule",
  "actor": [{"reference": "Practitioner/dr-smith"}],
  "extension": [
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "cardiac-surgery"}]
          }
        },
        {
          "url": "timezone",
          "valueCode": "America/Los_Angeles"
        },
        {
          "url": "duration",
          "valueDuration": {"value": 1, "unit": "h"}
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["mon", "tue", "wed"],
              "timeOfDay": ["11:00:00"],
              "duration": 4,
              "durationUnit": "h"
            }
          }
        }
      ]
    },
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "call-center-availability"}]
          }
        },
        {
          "url": "timezone",
          "valueCode": "America/New_York"
        },
        {
          "url": "duration",
          "valueDuration": {"value": 1, "unit": "h"}
        },
        {
          "url": "availability",
          "valueTiming": {
            "repeat": {
              "dayOfWeek": ["mon", "tue", "wed"],
              "timeOfDay": ["09:00:00"],
              "duration": 8,
              "durationUnit": "h"
            }
          }
        }
      ]
    }
  ]
}
```

---

## 📈 Priority and Inheritance Rules

### Configuration Priority (Highest to Lowest)

1. **Schedule with `serviceType` extension** matching requested service
   - Completely replaces defaults (all-or-nothing)
   - No attribute-level merging

2. **ActivityDefinition** with matching `code`
   - Used when Schedule doesn't override
   - Provides default parameters

3. **Generic Schedule availability**
   - Fallback when no service-specific config exists
   - Applies to all service types

### Inheritance Behavior

```
Request: service-type=new-patient-visit

┌─────────────────────────────────────────┐
│ 1. Check Schedule.serviceType override  │ ← Highest priority
│    (new-patient-visit specific)         │
└─────────────────────────────────────────┘
         │
         ├─ Found? → Use it
         │
         └─ Not found? ↓
         
┌─────────────────────────────────────────┐
│ 2. Check ActivityDefinition.code       │
│    (new-patient-visit defaults)         │
└─────────────────────────────────────────┘
         │
         ├─ Found? → Use it
         │
         └─ Not found? ↓
         
┌─────────────────────────────────────────┐
│ 3. Use generic Schedule availability    │ ← Lowest priority
│    (applies to all services)            │
└─────────────────────────────────────────┘
```

---

## 🎯 Key Capabilities Summary

### ✅ What Providers CAN Do

1. **Define Recurring Availability**
   - Multiple days of week
   - Multiple time windows
   - Duration-based windows
   - Timezone-aware

2. **Service-Specific Rules**
   - Different availability per service type
   - Different durations per service
   - Different constraints per service

3. **Time Constraints**
   - Alignment intervals (grid-based scheduling)
   - Alignment offsets (custom start times)
   - Buffer times (prep/cleanup)

4. **Capacity Management**
   - Booking limits per period
   - Multiple limits (daily + weekly)
   - Service-specific limits

5. **Block Time**
   - Temporary blocks (vacations)
   - Service-specific blocks
   - All-service blocks

6. **Multi-Resource Coordination**
   - Coordinate multiple schedules
   - Atomic transactions
   - Shared constraints

7. **Timezone Support**
   - Per-service timezones
   - Actor-level timezones
   - Multi-timezone providers

### 🚧 Coming Soon

1. **$hold Operation** - Temporary slot reservations
2. **$book Operation** - Full booking workflow
3. **$cancel Operation** - Cancellation workflow
4. **Multi-Schedule $find** - Query multiple schedules
5. **ActivityDefinition Integration** - Full service-level defaults

---

## 📚 Additional Resources

- [FHIR Schedule Resource](https://build.fhir.org/schedule.html)
- [FHIR Slot Resource](https://build.fhir.org/slot.html)
- [FHIR Appointment Resource](https://build.fhir.org/appointment.html)
- [Medplum Scheduling Documentation](/docs/scheduling/defining-availability)

---

**Last Updated:** February 2026
**FHIR Version:** R4
**Medplum Version:** 5.0.14
