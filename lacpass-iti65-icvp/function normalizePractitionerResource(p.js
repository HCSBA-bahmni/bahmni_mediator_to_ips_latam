function normalizePractitionerResource(prac) {
    if (!prac || prac.resourceType !== 'Practitioner') return;

    const identifiers = [
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PPN",
                        "display": "Passport number"
                    }
                ]
            },
            "system": "https://registrocivil.cl/pasaporte",
            "value": "P34567890"
        },
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PRN",
                        "display": "Provider number"
                    }
                ]
            },
            "system": "https://funcionarios.cl/id",
            "value": "P2Q3R"
        }
    ];

    const name = [
        {
            "use": "official",
            "family": "Barrios",
            "given": [
                "Gracia"
            ]
        }
    ];

    const address = [
        {
            "text": "Chile",
            "country": "CL"
        }
    ]

    const qualifications = [
        {
            "code": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0360/2.7",
                        "code": "RN",
                        "display": "Registered Nurse"
                    }
                ]
            }
        }
    ]

    prac.identifier = identifiers;
    prac.name = name;
    prac.gender = 'female';
    prac.birthDate = '1927-06-27';
    prac.qualification = qualifications;
    return prac;
}