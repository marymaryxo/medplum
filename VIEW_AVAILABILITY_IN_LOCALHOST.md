# Viewing FHIR Provider Availability Capabilities in Localhost

This guide will help you see all the provider availability capabilities running in your local development environment.

## 🚀 Quick Start

### 1. Start Background Services (PostgreSQL & Redis)

If not already running, start Docker services:

```bash
docker-compose up
```

Or if using `docker compose` (without hyphen):

```bash
docker compose up
```

### 2. Start the Medplum Server

In a new terminal:

```bash
cd packages/server
npm run dev
```

The server will start on **http://localhost:8103**

**Default credentials:**
- Email: `admin@example.com`
- Password: `medplum_admin`

Verify it's working: Visit [http://localhost:8103/healthcheck](http://localhost:8103/healthcheck)

### 3. Start the Medplum Web App

In another new terminal:

```bash
cd packages/app
npm run dev
```

The app will start on **http://localhost:3000**

---

## 📍 Where to See Availability Capabilities

### Option 1: Schedule Page (Provider App)

**URL:** [http://localhost:3000/schedule](http://localhost:3000/schedule)

**What you'll see:**
- Calendar view with your schedule
- Available slots displayed
- Ability to create appointments
- Service type selection (if configured)
- `$find` operation results in the sidebar

**How to use:**
1. Log in with `admin@example.com` / `medplum_admin`
2. Navigate to **Schedule** in the left sidebar
3. The page will automatically create a Schedule resource for your Practitioner if one doesn't exist
4. You'll see available slots based on your Schedule's availability configuration

---

### Option 2: View/Edit Schedule Resource Directly

**URL:** [http://localhost:3000/Schedule](http://localhost:3000/Schedule)

**What you'll see:**
- List of all Schedule resources
- Click on a Schedule to view/edit it
- See the `SchedulingParameters` extension with all availability settings

**To view availability configuration:**
1. Go to [http://localhost:3000/Schedule](http://localhost:3000/Schedule)
2. Click on your Schedule resource
3. Scroll to the **Extensions** section
4. Look for `SchedulingParameters` extension
5. Expand it to see all availability settings:
   - `availability` - Recurring time windows
   - `duration` - Appointment slot length
   - `bufferBefore` / `bufferAfter` - Buffer times
   - `alignmentInterval` / `alignmentOffset` - Time grid settings
   - `bookingLimit` - Capacity limits
   - `serviceType` - Service-specific overrides
   - `timezone` - Timezone settings

---

### Option 3: Test the `$find` Operation via API

**Endpoint:** `POST /fhir/R4/Schedule/{schedule-id}/$find`

**Example using curl:**

```bash
# First, get your Schedule ID
curl -X GET "http://localhost:8103/fhir/R4/Schedule?actor=Practitioner/{practitioner-id}" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Then use $find to get available slots
curl -X POST "http://localhost:8103/fhir/R4/Schedule/{schedule-id}/$find" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
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
  }'
```

**Or test in the browser console:**

1. Open [http://localhost:3000](http://localhost:3000)
2. Open browser DevTools (F12)
3. Go to Console tab
4. Run:

```javascript
// Get your Schedule
const schedule = await medplum.searchOne('Schedule', { 
  actor: 'Practitioner/YOUR_PRACTITIONER_ID' 
});

// Use $find operation
const result = await medplum.post(`fhir/R4/Schedule/${schedule.id}/$find`, {
  resourceType: 'Parameters',
  parameter: [
    {
      name: 'start',
      valueDateTime: new Date().toISOString()
    },
    {
      name: 'end',
      valueDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }
  ]
});

console.log('Available slots:', result);
```

---

### Option 4: Create/Edit Schedule with Availability Settings

**Via UI:**
1. Go to [http://localhost:3000/Schedule](http://localhost:3000/Schedule)
2. Click **New** or edit an existing Schedule
3. Add extensions manually in JSON editor

**Via API (using curl):**

```bash
curl -X PUT "http://localhost:8103/fhir/R4/Schedule/{schedule-id}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "resourceType": "Schedule",
    "id": "{schedule-id}",
    "actor": [{"reference": "Practitioner/{practitioner-id}"}],
    "active": true,
    "extension": [{
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "duration",
          "valueDuration": {
            "value": 30,
            "unit": "min"
          }
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
          "valueDuration": {
            "value": 5,
            "unit": "min"
          }
        },
        {
          "url": "bufferAfter",
          "valueDuration": {
            "value": 5,
            "unit": "min"
          }
        },
        {
          "url": "alignmentInterval",
          "valueDuration": {
            "value": 15,
            "unit": "min"
          }
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
  }'
```

---

## 🎯 Key Pages to Visit

### 1. Schedule Calendar View
**URL:** [http://localhost:3000/schedule](http://localhost:3000/schedule)
- See your calendar with available slots
- Create appointments
- View `$find` operation results

### 2. Schedule Resource List
**URL:** [http://localhost:3000/Schedule](http://localhost:3000/Schedule)
- View all Schedule resources
- Edit Schedule configurations
- See availability extensions

### 3. ActivityDefinition Resources
**URL:** [http://localhost:3000/ActivityDefinition](http://localhost:3000/ActivityDefinition)
- View service-level default configurations
- See how ActivityDefinitions define default scheduling parameters

### 4. Slot Resources
**URL:** [http://localhost:3000/Slot](http://localhost:3000/Slot)
- View created Slot resources
- See booked time (status: `busy`)
- See blocked time (status: `busy-unavailable`)

### 5. Appointment Resources
**URL:** [http://localhost:3000/Appointment](http://localhost:3000/Appointment)
- View booked appointments
- See how appointments link to Slots

---

## 🔍 What to Look For

### In Schedule Resource:

1. **Extensions Section:**
   - Look for `SchedulingParameters` extension
   - Check for `availability` timing patterns
   - See `duration`, `bufferBefore`, `bufferAfter`
   - Check `alignmentInterval` and `alignmentOffset`
   - Look for `bookingLimit` entries
   - Check for `serviceType` overrides
   - See `timezone` settings

2. **Service Types:**
   - Check `serviceType` field for service type codes
   - See how different service types can have different availability

### In Schedule Page:

1. **Calendar View:**
   - Available slots displayed as time blocks
   - Booked appointments shown
   - Blocked time shown

2. **Sidebar:**
   - Service type selection (if multiple configured)
   - Available slots from `$find` operation
   - Click slots to create appointments

### In API Responses:

1. **$find Operation:**
   - Returns Bundle of Slot resources
   - Each Slot represents an available time slot
   - Slots respect all availability constraints

2. **Schedule Resource:**
   - Contains all availability configuration
   - Extensions define scheduling parameters
   - Actor reference links to Practitioner/Location/Device

---

## 📝 Example: Create a Schedule with Full Availability Configuration

Here's a complete example you can use to create a Schedule with all availability capabilities:

```json
{
  "resourceType": "Schedule",
  "actor": [{"reference": "Practitioner/YOUR_PRACTITIONER_ID"}],
  "active": true,
  "serviceType": [
    {"coding": [{"code": "office-visit", "display": "Office Visit"}]},
    {"coding": [{"code": "follow-up", "display": "Follow-up Visit"}]}
  ],
  "extension": [
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "duration",
          "valueDuration": {
            "value": 30,
            "unit": "min"
          }
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
          "valueDuration": {
            "value": 5,
            "unit": "min"
          }
        },
        {
          "url": "bufferAfter",
          "valueDuration": {
            "value": 5,
            "unit": "min"
          }
        },
        {
          "url": "alignmentInterval",
          "valueDuration": {
            "value": 15,
            "unit": "min"
          }
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
    },
    {
      "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
      "extension": [
        {
          "url": "serviceType",
          "valueCodeableConcept": {
            "coding": [{"code": "office-visit"}]
          }
        },
        {
          "url": "duration",
          "valueDuration": {
            "value": 60,
            "unit": "min"
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
    }
  ]
}
```

This example shows:
- ✅ Default availability: Mon-Fri 9am-5pm
- ✅ Service-specific override: Office visits only Tue/Thu 9am-1pm
- ✅ Different durations per service type
- ✅ Buffer times
- ✅ Alignment intervals
- ✅ Booking limits

---

## 🐛 Troubleshooting

### Server not starting?
- Check PostgreSQL is running: `docker ps`
- Check Redis is running: `docker ps`
- Verify ports 8103 and 3000 are not in use

### Can't see Schedule page?
- Make sure you're logged in
- Check browser console for errors
- Verify server is running on port 8103

### $find operation not working?
- Make sure Schedule has `SchedulingParameters` extension
- Check that `duration` is set (required)
- Verify date range is in the future
- Check browser network tab for API errors

### No slots appearing?
- Schedule might not have availability configured
- Check Schedule extensions for `availability` timing
- Verify date range includes available times
- Check for existing blocked Slots

---

## 📚 Next Steps

1. **Explore the Schedule page** - See how availability is displayed
2. **Edit a Schedule resource** - Add availability extensions
3. **Test $find operation** - See available slots returned
4. **Create appointments** - Book time slots
5. **View Slot resources** - See how booked time is represented
6. **Check ActivityDefinitions** - See service-level defaults

For more details, see: [FHIR_PROVIDER_AVAILABILITY_CAPABILITIES.md](./FHIR_PROVIDER_AVAILABILITY_CAPABILITIES.md)
