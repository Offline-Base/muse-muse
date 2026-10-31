import unittest, torch

def damp(g, o):
    m = o.max()
    return g / (1 + 20 * o / m)

class TestDamp(unittest.TestCase):
    def test_damping(self):
        g = torch.tensor([1.0, 2.0, 4.0])
        o = torch.tensor([1.0, 3.0, 0.0])
        m = 3.0
        expected = g / (1 + 20 * o / m)
        got = damp(g, o)
        self.assertTrue(torch.allclose(got, expected))
        self.assertAlmostEqual(got[0].item(), 1.0 / (1 + 20 / 3))
        self.assertAlmostEqual(got[1].item(), 2.0 / 21.0)
        self.assertAlmostEqual(got[2].item(), 4.0)

if __name__ == "__main__":
    unittest.main()
