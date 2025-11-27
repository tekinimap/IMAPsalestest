// Mock People Data for Local Testing
export const mockPeople = [
    { id: 'p1', name: 'Anna Schmidt', team: 'Public Impact', email: 'anna.schmidt@example.com' },
    { id: 'p2', name: 'Max Müller', team: 'Organisational Excellence', email: 'max.mueller@example.com' },
    { id: 'p3', name: 'Lisa Weber', team: 'Public Impact', email: 'lisa.weber@example.com' },
    { id: 'p4', name: 'Tom Fischer', team: 'Organisational Excellence', email: 'tom.fischer@example.com' },
    { id: 'p5', name: 'Sarah Klein', team: 'Public Impact', email: 'sarah.klein@example.com' },
    { id: 'p6', name: 'Michael Wagner', team: 'Organisational Excellence', email: 'michael.wagner@example.com' },
    { id: 'p7', name: 'Julia Becker', team: 'Public Impact', email: 'julia.becker@example.com' },
    { id: 'p8', name: 'David Schulz', team: 'Organisational Excellence', email: 'david.schulz@example.com' }
];

export function findMockPersonByName(name) {
    if (!name) return null;
    const normalized = name.toLowerCase().trim();
    return mockPeople.find(p => p.name.toLowerCase().includes(normalized)) || null;
}

export function getMockPeopleList() {
    return mockPeople;
}
